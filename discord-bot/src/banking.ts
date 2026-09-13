import {
  BANKING_RESOURCE_KEYS,
  BankingLedgerDoc,
  BankingResourceBalance,
  NationBankBalanceWithRegistrationDoc,
  Database,
} from './database';
import { BankTransactionRecord, BankTransferRequest, PnWClient } from './pnw_api';

const EPSILON = 0.000001;

export interface BankingRuntimeDefaults {
  enabled: boolean;
  offshoreAllianceId: number | null;
  allianceBankAllianceId: number | null;
  allianceBankApiKeyRef: string | null;
  offshoreApiKeyRef: string | null;
  botKey: string | null;
  depositRequiredWords: string[];
  syncFetchLimit: number;
}

export interface SyncResult {
  processed: number;
  skipped: number;
  newDeposits: BankingLedgerDoc[];
}

interface PnWBankingClient {
  getAllianceBankTransactions(allianceId: number, opts?: { minId?: number; limit?: number }): Promise<BankTransactionRecord[]>;
  getLatestAllianceBankTransactionId?(allianceId: number): Promise<string | null>;
  getAllianceBankBalance(allianceId: number): Promise<Partial<BankingResourceBalance>>;
  bankWithdraw(request: BankTransferRequest): Promise<BankTransactionRecord>;
}

type PnWBankingClientFactory = (apiKey: string) => PnWBankingClient;

function emptyBalance(): BankingResourceBalance {
  const balance = {} as BankingResourceBalance;
  for (const key of BANKING_RESOURCE_KEYS) balance[key] = 0;
  return balance;
}

function normalizeBalance(input: Partial<BankingResourceBalance> | null | undefined): BankingResourceBalance {
  const out = emptyBalance();
  if (!input) return out;
  for (const key of BANKING_RESOURCE_KEYS) {
    const value = input[key];
    if (typeof value === 'number' && Number.isFinite(value)) out[key] = value;
  }
  return out;
}

function hasAnyAmount(balance: BankingResourceBalance): boolean {
  return BANKING_RESOURCE_KEYS.some((key) => Math.abs(balance[key]) > EPSILON);
}


function subtractBalance(available: BankingResourceBalance, needed: BankingResourceBalance): BankingResourceBalance {
  const next = { ...available } as BankingResourceBalance;
  for (const key of BANKING_RESOURCE_KEYS) next[key] -= needed[key];
  return next;
}

function addBalance(a: BankingResourceBalance, b: BankingResourceBalance): BankingResourceBalance {
  const next = { ...a } as BankingResourceBalance;
  for (const key of BANKING_RESOURCE_KEYS) next[key] += b[key];
  return next;
}

function allocateBalance(available: BankingResourceBalance, needed: BankingResourceBalance): BankingResourceBalance {
  const allocated = emptyBalance();
  for (const key of BANKING_RESOURCE_KEYS) allocated[key] = Math.min(Math.max(available[key], 0), Math.max(needed[key], 0));
  return allocated;
}

export function balanceToNote(balance: BankingResourceBalance): string {
  return BANKING_RESOURCE_KEYS
    .filter((key) => Math.abs(balance[key]) > EPSILON)
    .map((key) => `${key}:${Math.trunc(balance[key] * 100) / 100}`)
    .join(', ') || 'no resources';
}

function parseCursorId(value: string | null): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return parsed;
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error ?? 'Unknown error');
}

function isDuplicateKeyError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  return (error as { code?: unknown }).code === 11000;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export class BankingService {
  private readonly _db: Database;
  private readonly _defaults: BankingRuntimeDefaults;
  private readonly _fallbackPnwApiKey: string;
  private readonly _clientFactory: PnWBankingClientFactory;

  constructor(
    db: Database,
    defaults: BankingRuntimeDefaults,
    fallbackPnwApiKey: string,
    clientFactory: PnWBankingClientFactory = (apiKey) => new PnWClient(apiKey)
  ) {
    this._db = db;
    this._defaults = {
      ...defaults,
      depositRequiredWords: defaults.depositRequiredWords.map((word) => word.trim().toLowerCase()).filter(Boolean),
      syncFetchLimit: Math.max(1, Math.min(1000, Math.floor(defaults.syncFetchLimit || 100))),
    };
    this._fallbackPnwApiKey = fallbackPnwApiKey;
    this._clientFactory = clientFactory;
  }

  private async _creditOffshoredDeposits(
    guildId: string,
    offshoredResources: BankingResourceBalance
  ): Promise<{ credited: BankingResourceBalance; alliancePool: BankingResourceBalance }> {
    let remaining = normalizeBalance(offshoredResources);
    const credited = emptyBalance();
    const offshoreSetAt = await this._db.getGlobalOffshoreSetAt();
    const pendingDeposits = await this._db.getBankingLedgerByTypeAndStatus(guildId, 'deposit', 'pending', 500);
    // Deposits recorded before the offshore alliance was (last) configured aren't
    // attributed to nations here — they're excluded from matching so that only
    // deposits made after offshore was set get counted toward nation balances.
    const eligibleDeposits = offshoreSetAt
      ? pendingDeposits.filter((deposit) => deposit.created_at >= offshoreSetAt)
      : pendingDeposits;
    for (const deposit of eligibleDeposits) {
      if (!hasAnyAmount(remaining)) break;
      const resources = normalizeBalance(deposit.resources);
      const allocated = allocateBalance(remaining, resources);
      if (!hasAnyAmount(allocated)) continue;
      const registration = deposit.nation_id ? await this._db.getByNationId(deposit.nation_id) : null;
      if (registration && deposit.nation_id != null) {
        await this._db.creditNationBankBalance(guildId, registration.nation_id, allocated);
      } else {
        await this._db.creditAlliancePoolBalance(guildId, allocated);
      }
      remaining = subtractBalance(remaining, allocated);
      const leftoverDeposit = subtractBalance(resources, allocated);
      if (hasAnyAmount(leftoverDeposit)) {
        await this._db.updateBankingLedgerResources(deposit.ledger_id, leftoverDeposit);
      } else {
        await this._db.updateBankingLedgerStatus(deposit.ledger_id, 'completed');
      }
      for (const key of BANKING_RESOURCE_KEYS) credited[key] += allocated[key];
    }
    if (hasAnyAmount(remaining)) {
      await this._db.creditAlliancePoolBalance(guildId, remaining);
      for (const key of BANKING_RESOURCE_KEYS) credited[key] += remaining[key];
    }
    const alliancePool = await this._db.getAlliancePoolBalance(guildId);
    return { credited, alliancePool };
  }

  private _depositHasRequiredWord(note: string | null | undefined): boolean {
    const requiredWords = this._defaults.depositRequiredWords;
    if (requiredWords.length === 0) return true;
    const normalizedNote = (note ?? '').toLowerCase();
    return requiredWords.some((word) => new RegExp(`(^|\\W)${escapeRegex(word)}($|\\W)`, 'i').test(normalizedNote));
  }

  private _resolveApiKey(apiKeyRef: string | null): string {
    const direct = (apiKeyRef ?? '').trim();
    if (!direct) return this._fallbackPnwApiKey;
    const envRef = direct.startsWith('env:') ? direct.slice(4).trim() : '';
    if (envRef) return (process.env[envRef] || '').trim();
    const envFallback = (process.env[direct] || '').trim();
    return envFallback || direct;
  }

  /**
   * Resolve only an explicitly configured per-guild API key reference/value.
   * Unlike _resolveApiKey, this intentionally does NOT fall back to the
   * bot-wide default key.
   */
  private _resolveConfiguredApiKey(apiKeyRef: string | null): string {
    const direct = (apiKeyRef ?? '').trim();
    if (!direct) return '';
    const envRef = direct.startsWith('env:') ? direct.slice(4).trim() : '';
    if (envRef) return (process.env[envRef] || '').trim();
    const envFallback = (process.env[direct] || '').trim();
    return envFallback || direct;
  }

  async ensureGuildConfig(guildId: string): Promise<void> {
    const cfg = await this._db.getBankingConfig(guildId);
    const patch: Record<string, unknown> = {};
    if (cfg.alliance_bank_alliance_id == null && this._defaults.allianceBankAllianceId != null) {
      patch['alliance_bank_alliance_id'] = this._defaults.allianceBankAllianceId;
    }
    if (!cfg.alliance_bank_api_key_ref && this._defaults.allianceBankApiKeyRef) {
      patch['alliance_bank_api_key_ref'] = this._defaults.allianceBankApiKeyRef;
    }
    if (!cfg.offshore_api_key_ref && this._defaults.offshoreApiKeyRef) {
      patch['offshore_api_key_ref'] = this._defaults.offshoreApiKeyRef;
    }
    if (!cfg.bot_key && this._defaults.botKey) {
      patch['bot_key'] = this._defaults.botKey;
    }
    if (typeof cfg.enabled !== 'boolean') {
      patch['enabled'] = this._defaults.enabled;
    }
    if (Object.keys(patch).length > 0) {
      await this._db.setBankingConfig(guildId, patch);
    }
  }

  async getBankingEnabled(guildId: string): Promise<boolean> {
    return this._db.getBankingEnabled(guildId);
  }

  async setBankingEnabled(guildId: string, enabled: boolean): Promise<boolean> {
    const row = await this._db.setBankingEnabled(guildId, enabled);
    return row.enabled;
  }

  async setApiKeyRefs(
    guildId: string,
    allianceBankApiKeyRef: string,
    offshoreApiKeyRef: string
  ): Promise<void> {
    await this._db.setBankingConfig(guildId, {
      alliance_bank_api_key_ref: allianceBankApiKeyRef.trim(),
      offshore_api_key_ref: offshoreApiKeyRef.trim(),
    });
  }

  async getOffshoreAllianceId(): Promise<number | null> {
    return this._db.getGlobalOffshoreAllianceId(this._defaults.offshoreAllianceId);
  }

  async setOffshoreAllianceId(
    allianceId: number,
    guildId: string | null = null,
    actorDiscordId: string | null = null
  ): Promise<{ offshoreAllianceId: number; migrated: boolean; resources: BankingResourceBalance | null }> {
    const previousAllianceId = await this.getOffshoreAllianceId();
    if (previousAllianceId && previousAllianceId !== allianceId) {
      if (!guildId) {
        throw new Error('A guild context is required to migrate existing offshore holdings.');
      }
      const cfg = await this._db.getBankingConfig(guildId);
      const offshoreKey = this._resolveApiKey(cfg.offshore_api_key_ref);
      if (!offshoreKey) throw new Error('Offshore API key is not configured; cannot migrate existing offshore holdings.');
      const client = this._clientFactory(offshoreKey);
      const resources = normalizeBalance(await client.getAllianceBankBalance(previousAllianceId));
      if (hasAnyAmount(resources)) {
        const ledger = await this._db.createBankingLedgerEntry({
          guild_id: guildId,
          nation_id: null,
          type: 'offshore-migration',
          status: 'pending',
          resources,
          source_transaction_id: null,
          idempotency_key: `offshore-migration:${previousAllianceId}:${allianceId}:${Date.now()}`,
          note: `Migrate offshore holdings from ${previousAllianceId} to ${allianceId}`,
          actor_discord_id: actorDiscordId,
          error: null,
        });
        try {
          const transfer = await client.bankWithdraw({
            receiverId: allianceId,
            receiverType: 2,
            resources,
            note: `bar3-offshore-migration ${previousAllianceId}->${allianceId}`,
          });
          await this._db.updateBankingLedgerStatus(ledger.ledger_id, 'completed');
          await this._db.markImportedBankTransaction(
            guildId,
            `offshore-migration-transfer:${transfer.id}`,
            transfer.id,
            ledger.ledger_id
          );
        } catch (error) {
          await this._db.updateBankingLedgerStatus(ledger.ledger_id, 'failed', toErrorMessage(error));
          throw error;
        }
      }
      await this._db.setGlobalOffshoreAllianceId(allianceId);
      return { offshoreAllianceId: allianceId, migrated: hasAnyAmount(resources), resources };
    }
    await this._db.setGlobalOffshoreAllianceId(allianceId);
    return { offshoreAllianceId: allianceId, migrated: false, resources: null };
  }

  /**
   * Processes a single bank transaction pushed by the `bankrec/create` WS
   * subscription (see PnWSubscriptionClient.iterBankRecCreates). This is
   * the push-based counterpart to the deposit-detection branch inside
   * syncGuildDeposits — same idempotency key scheme, same required-word and
   * offshore-configured checks — so it's safe to run alongside the REST
   * poll: whichever path sees a given transaction first wins, and the
   * other's attempt is silently absorbed by the unique
   * (guild_id, source_transaction_id) ledger index. Returns the created
   * ledger entry, or null if the transaction was filtered, already seen,
   * or otherwise not something to log.
   */
  async handleIncomingBankRecDeposit(
    guildId: string,
    tx: BankTransactionRecord
  ): Promise<BankingLedgerDoc | null> {
    const cfg = await this._db.getBankingConfig(guildId);
    if (!cfg.enabled) return null;
    if (!cfg.alliance_bank_alliance_id) return null;
    if (tx.receiverId !== cfg.alliance_bank_alliance_id || tx.receiverType !== 2) return null;
    // Only nation -> alliance transfers are tracked as member deposits; a
    // sender_type of 2 would be another alliance sending funds, which isn't
    // attributable to a single member and is left for manual handling.
    if (tx.senderType !== 1) return null;
    const resources = normalizeBalance(tx.resources);
    if (!hasAnyAmount(resources)) return null;

    const idempotencyKey = `deposit:${cfg.alliance_bank_alliance_id}:${tx.id}`;
    const offshoreAllianceId = await this.getOffshoreAllianceId();
    if (!offshoreAllianceId) {
      // Offshore isn't configured yet — mark seen so it's never replayed
      // later, but don't create a ledger entry or log it, matching the poll.
      await this._db.markImportedBankTransaction(guildId, idempotencyKey, tx.id, null);
      return null;
    }
    const offshoreApiKey = this._resolveConfiguredApiKey(cfg.offshore_api_key_ref);
    if (!offshoreApiKey) {
      // If the guild has no offshore API key configured, don't log/track member
      // deposit transactions yet; mark seen to prevent replay spam later.
      await this._db.markImportedBankTransaction(guildId, idempotencyKey, tx.id, null);
      return null;
    }
    if (!this._depositHasRequiredWord(tx.note)) {
      await this._db.markImportedBankTransaction(guildId, idempotencyKey, tx.id, null);
      return null;
    }

    try {
      const depositLedger = await this._db.createBankingLedgerEntry({
        guild_id: guildId,
        nation_id: tx.senderId || null,
        type: 'deposit',
        status: 'pending',
        resources,
        source_transaction_id: tx.id,
        idempotency_key: idempotencyKey,
        note: tx.note || null,
        actor_discord_id: null,
        error: null,
      });
      await this._db.markImportedBankTransaction(guildId, idempotencyKey, tx.id, depositLedger.ledger_id);
      return depositLedger;
    } catch (error) {
      if (isDuplicateKeyError(error)) return null;
      throw error;
    }
  }

  /**
   * Resolves the alliance ID + API key a guild's bank-deposit WS listener
   * should use, or null if banking isn't fully configured for it yet.
   */
  async getBankSubscriptionContext(guildId: string): Promise<{ allianceId: number; apiKey: string } | null> {
    const cfg = await this._db.getBankingConfig(guildId);
    if (!cfg.enabled) return null;
    if (!cfg.alliance_bank_alliance_id) return null;
    const apiKey = this._resolveApiKey(cfg.alliance_bank_api_key_ref);
    if (!apiKey) return null;
    return { allianceId: cfg.alliance_bank_alliance_id, apiKey };
  }

  /**
   * Resolves the offshore alliance ID + API key a guild's offshore-deposit
   * WS listener should use, or null if the offshore alliance / its API key
   * isn't configured yet.
   */
  async getOffshoreSubscriptionContext(guildId: string): Promise<{ allianceId: number; apiKey: string } | null> {
    const cfg = await this._db.getBankingConfig(guildId);
    if (!cfg.enabled) return null;
    const offshoreAllianceId = await this.getOffshoreAllianceId();
    if (!offshoreAllianceId) return null;
    const apiKey = this._resolveApiKey(cfg.offshore_api_key_ref);
    if (!apiKey) return null;
    return { allianceId: offshoreAllianceId, apiKey };
  }

  /**
   * Processes a transaction pushed by the OFFSHORE alliance's own
   * `bankrec/create` WS subscription (as opposed to handleIncomingBankRecDeposit,
   * which watches the main alliance bank). This fires for deposits landing
   * directly in the offshore alliance. When the transaction's banker is the
   * same nation as the sender — i.e. the nation banked its own funds rather
   * than a gov/banker moving funds on their behalf — the amount is credited
   * straight to that nation's tracked balance, since the funds are already
   * sitting in the offshore alliance and there's nothing left to sweep there.
   * Transactions where the banker differs from the sender are left alone
   * here (not auto-attributed) and fall back to the existing manual-offshore
   * / ledger-sweep flow. Returns the created ledger entry (already
   * 'completed', since no forwarding is needed), or null if the transaction
   * wasn't eligible for auto-crediting or was already seen.
   */
  async handleIncomingOffshoreDeposit(
    guildId: string,
    tx: BankTransactionRecord
  ): Promise<BankingLedgerDoc | null> {
    const cfg = await this._db.getBankingConfig(guildId);
    if (!cfg.enabled) return null;
    const offshoreAllianceId = await this.getOffshoreAllianceId();
    if (!offshoreAllianceId) return null;
    if (tx.receiverId !== offshoreAllianceId || tx.receiverType !== 2) return null;
    // Only nation -> alliance transfers can be attributed to a single sender;
    // alliance -> alliance transfers (e.g. this guild's own manual-offshore
    // sweep landing here) aren't self-deposits.
    if (tx.senderType !== 1) return null;
    // Only auto-credit when the nation banked its own funds directly. If a
    // different nation (a banker/gov member) executed the transfer, it isn't
    // safe to assume the funds belong to the sender's balance.
    if (tx.bankerId !== tx.senderId) return null;

    const resources = normalizeBalance(tx.resources);
    if (!hasAnyAmount(resources)) return null;

    const idempotencyKey = `offshore-deposit:${offshoreAllianceId}:${tx.id}`;
    try {
      const registration = await this._db.getByNationId(tx.senderId);
      const depositLedger = await this._db.createBankingLedgerEntry({
        guild_id: guildId,
        nation_id: tx.senderId,
        type: 'offshore-deposit',
        status: 'completed',
        resources,
        source_transaction_id: tx.id,
        idempotency_key: idempotencyKey,
        note: tx.note || null,
        actor_discord_id: null,
        error: null,
      });
      if (registration) {
        await this._db.creditNationBankBalance(guildId, registration.nation_id, resources);
      } else {
        // No linked registration for this nation — fall back to the shared
        // alliance pool rather than silently dropping the credit.
        await this._db.creditAlliancePoolBalance(guildId, resources);
      }
      await this._db.markImportedBankTransaction(guildId, idempotencyKey, tx.id, depositLedger.ledger_id);
      return depositLedger;
    } catch (error) {
      if (isDuplicateKeyError(error)) return null;
      throw error;
    }
  }

  async syncGuildDeposits(guildId: string): Promise<SyncResult> {
    await this.ensureGuildConfig(guildId);
    const result: SyncResult = { processed: 0, skipped: 0, newDeposits: [] };
    const cfg = await this._db.getBankingConfig(guildId);
    if (!cfg.enabled) return result;
    if (!cfg.bot_key) throw new Error(`Banking is enabled for guild ${guildId} but bot_key is missing.`);
    if (!cfg.alliance_bank_alliance_id) {
      throw new Error(`Banking is enabled for guild ${guildId} but alliance bank alliance ID is missing.`);
    }

    const allianceBankKey = this._resolveApiKey(cfg.alliance_bank_api_key_ref);
    if (!allianceBankKey) {
      throw new Error(`Banking is enabled for guild ${guildId} but the alliance bank API key reference is unresolved.`);
    }

    const allianceBankClient = this._clientFactory(allianceBankKey);
    const minId = parseCursorId(cfg.last_sync_cursor);

    if (minId == null) {
      // First-ever sync for this guild. The bankrecs API only supports orderBy ASC
      // with a min_id filter, so a null cursor would otherwise pull the OLDEST
      // transactions in the alliance's entire bank history (up to the fetch
      // limit) and treat every one of them as "new" — spamming a deposit log
      // per row. Instead, baseline the cursor at the current newest transaction
      // and do no processing this run; only transactions from this point
      // forward are tracked.
      if (typeof allianceBankClient.getLatestAllianceBankTransactionId === 'function') {
        try {
          const latestId = await allianceBankClient.getLatestAllianceBankTransactionId(cfg.alliance_bank_alliance_id);
          await this._db.setBankingConfig(guildId, {
            last_sync_cursor: latestId,
            last_sync_at: new Date().toISOString(),
          });
          return result;
        } catch {
          // Fallback for older/mock clients that don't support latest-id lookup.
          // In this compatibility mode we continue below and process the fetched
          // page directly instead of hard-failing the sync.
        }
      }
    }

    const transactions = await allianceBankClient.getAllianceBankTransactions(cfg.alliance_bank_alliance_id, {
      minId: minId == null ? undefined : minId + 1,
      limit: this._defaults.syncFetchLimit,
    });
    const relatedTransactions = transactions
      .filter((tx) =>
        (tx.senderType === 1 && tx.receiverType === 2 && tx.receiverId === cfg.alliance_bank_alliance_id) ||
        (tx.senderType === 2 && tx.senderId === cfg.alliance_bank_alliance_id && tx.receiverType === 1)
      )
      .sort((a, b) => Number.parseInt(a.id, 10) - Number.parseInt(b.id, 10));

    let lastSeenCursor = cfg.last_sync_cursor;
    for (const tx of relatedTransactions) {
      lastSeenCursor = tx.id;
      const resources = normalizeBalance(tx.resources);
      if (!hasAnyAmount(resources)) {
        result.skipped += 1;
        continue;
      }

      const isDeposit = tx.senderType === 1 && tx.receiverType === 2 && tx.receiverId === cfg.alliance_bank_alliance_id;
      if (isDeposit) {
        const idempotencyKey = `deposit:${cfg.alliance_bank_alliance_id}:${tx.id}`;
        const offshoreAllianceId = await this.getOffshoreAllianceId();
        if (!offshoreAllianceId) {
          // Offshore isn't configured yet — mark the transaction as seen so it's
          // never replayed later, but don't create a ledger entry or log it.
          // Deposit tracking only starts once an offshore alliance is set.
          await this._db.markImportedBankTransaction(guildId, idempotencyKey, tx.id, null);
          result.skipped += 1;
          continue;
        }
        const offshoreApiKey = this._resolveConfiguredApiKey(cfg.offshore_api_key_ref);
        if (!offshoreApiKey) {
          await this._db.markImportedBankTransaction(guildId, idempotencyKey, tx.id, null);
          result.skipped += 1;
          continue;
        }
        if (!this._depositHasRequiredWord(tx.note)) {
          await this._db.markImportedBankTransaction(guildId, idempotencyKey, tx.id, null);
          result.skipped += 1;
          continue;
        }
        // Deposits are recorded and left pending in the alliance bank. They are
        // NOT auto-forwarded to the offshore alliance — that only happens when
        // a gov/econ user explicitly runs /banking manual_offshore, which sweeps
        // the alliance bank and credits any matching pending deposit ledger
        // entries via _creditOffshoredDeposits at that time.
        try {
          const depositLedger = await this._db.createBankingLedgerEntry({
            guild_id: guildId,
            nation_id: tx.senderId || null,
            type: 'deposit',
            status: 'pending',
            resources,
            source_transaction_id: tx.id,
            idempotency_key: idempotencyKey,
            note: tx.note || null,
            actor_discord_id: null,
            error: null,
          });
          await this._db.markImportedBankTransaction(guildId, idempotencyKey, tx.id, depositLedger.ledger_id);
          result.processed += 1;
          result.newDeposits.push(depositLedger);
        } catch (error) {
          if (isDuplicateKeyError(error)) {
            result.skipped += 1;
            continue;
          }
          throw error;
        }
        continue;
      }

      const idempotencyKey = `external-withdrawal:${cfg.alliance_bank_alliance_id}:${tx.id}`;
      let withdrawalLedger: BankingLedgerDoc;
      try {
        const registration = tx.receiverId > 0 ? await this._db.getByNationId(tx.receiverId) : null;
        withdrawalLedger = await this._db.createBankingLedgerEntry({
          guild_id: guildId,
          nation_id: registration?.nation_id ?? (tx.receiverId || null),
          type: 'external-withdrawal',
          status: 'pending',
          resources,
          source_transaction_id: tx.id,
          idempotency_key: idempotencyKey,
          note: tx.note || 'External alliance-bank withdrawal detected',
          actor_discord_id: null,
          error: null,
        });
        const debited = registration
          ? await this._db.debitNationBankBalance(guildId, registration.nation_id, resources)
          : await this._db.debitAlliancePoolBalance(guildId, resources);
        if (!debited.ok) {
          await this._db.updateBankingLedgerStatus(
            withdrawalLedger.ledger_id,
            'failed',
            'External withdrawal exceeded tracked balance. Manual reconcile required before trusting this balance.'
          );
          result.skipped += 1;
          continue;
        }
        await this._db.updateBankingLedgerStatus(withdrawalLedger.ledger_id, 'completed');
        await this._db.markImportedBankTransaction(guildId, idempotencyKey, tx.id, withdrawalLedger.ledger_id);
        result.processed += 1;
      } catch (error) {
        if (isDuplicateKeyError(error)) {
          result.skipped += 1;
          continue;
        }
        throw error;
      }
    }

    if (lastSeenCursor && lastSeenCursor !== cfg.last_sync_cursor) {
      await this._db.setBankingConfig(guildId, {
        last_sync_cursor: lastSeenCursor,
        last_sync_at: new Date().toISOString(),
      });
    } else {
      await this._db.setBankingConfig(guildId, { last_sync_at: new Date().toISOString() });
    }

    return result;
  }


  async withdrawToNation(
    guildId: string,
    nationId: number,
    resourcesInput: Partial<BankingResourceBalance>,
    actorDiscordId: string,
    destinationNationId: number | null = null
  ): Promise<{ ok: true; remaining: BankingResourceBalance } | { ok: false; error: string; remaining?: BankingResourceBalance }> {
    const cfg = await this._db.getBankingConfig(guildId);
    if (!cfg.enabled) return { ok: false, error: 'Banking is currently disabled for this guild.' };
    if (!cfg.bot_key) return { ok: false, error: 'Banking configuration is missing bot_key.' };
    const offshoreKey = this._resolveApiKey(cfg.offshore_api_key_ref);
    if (!offshoreKey) return { ok: false, error: 'Offshore API key is not configured.' };
    const resources = normalizeBalance(resourcesInput);
    if (!hasAnyAmount(resources)) return { ok: false, error: 'Provide at least one positive resource amount.' };
    // The balance debited is always the caller's own registered/tracked nation
    // (nationId) — only who the in-game PnW transfer is *sent to* (recipientNationId)
    // is configurable. This keeps withdrawals from being able to drain someone
    // else's tracked balance while still letting a user redirect their own funds
    // to an alt or teammate.
    const recipientNationId = destinationNationId && destinationNationId > 0 ? destinationNationId : nationId;
    if (!Number.isInteger(recipientNationId) || recipientNationId <= 0) {
      return { ok: false, error: 'Destination nation ID must be a positive integer.' };
    }
    const current = await this._db.getNationBankBalance(guildId, nationId);
    for (const key of BANKING_RESOURCE_KEYS) {
      if (resources[key] > current[key]) {
        return { ok: false, error: `Insufficient ${key} balance.`, remaining: current };
      }
    }

    const offshoreClient = this._clientFactory(offshoreKey);
    const ledger = await this._db.createBankingLedgerEntry({
      guild_id: guildId,
      nation_id: nationId,
      type: 'withdraw',
      status: 'pending',
      resources,
      source_transaction_id: null,
      idempotency_key: `withdraw:${guildId}:${nationId}:${recipientNationId}:${Date.now()}`,
      note: recipientNationId === nationId
        ? `Withdraw to nation ${nationId} (${balanceToNote(resources)})`
        : `Withdraw from nation ${nationId} balance, sent to nation ${recipientNationId} (${balanceToNote(resources)})`,
      actor_discord_id: actorDiscordId,
      error: null,
    });
    try {
      const transfer = await offshoreClient.bankWithdraw({
        receiverId: recipientNationId,
        receiverType: 1,
        resources,
        note: recipientNationId === nationId
          ? `bar3-withdraw nation:${nationId}`
          : `bar3-withdraw nation:${nationId}->${recipientNationId}`,
      });
      const debited = await this._db.debitNationBankBalance(guildId, nationId, resources);
      if (!debited.ok) {
        await this._db.updateBankingLedgerStatus(
          ledger.ledger_id,
          'failed',
          `Transfer ${transfer.id} succeeded but balance debit failed. Manual reconcile required.`
        );
        return { ok: false, error: 'Withdrawal transfer succeeded but balance update failed. Staff has been alerted.' };
      }
      await this._db.updateBankingLedgerStatus(ledger.ledger_id, 'completed');
      return { ok: true, remaining: debited.balance };
    } catch (error) {
      await this._db.updateBankingLedgerStatus(ledger.ledger_id, 'failed', toErrorMessage(error));
      return { ok: false, error: toErrorMessage(error) };
    }
  }

  /**
   * Moves resources between two tracked nation balances entirely within the
   * database — debits fromNationId and credits toNationId. No PnW bank API
   * call is made and no in-game transfer happens; this only ever moves the
   * bot's own bookkeeping of who "owns" already-offshored funds. Useful for
   * e.g. splitting a balance between alts or handing off tracked funds to a
   * teammate without touching the offshore alliance.
   */
  async transferToNation(
    guildId: string,
    fromNationId: number,
    toNationId: number,
    resourcesInput: Partial<BankingResourceBalance>,
    actorDiscordId: string,
    note: string | null = null
  ): Promise<{ ok: true; remaining: BankingResourceBalance } | { ok: false; error: string; remaining?: BankingResourceBalance }> {
    const cfg = await this._db.getBankingConfig(guildId);
    if (!cfg.enabled) return { ok: false, error: 'Banking is currently disabled for this guild.' };
    if (!Number.isInteger(fromNationId) || fromNationId <= 0) {
      return { ok: false, error: 'Source nation ID must be a positive integer.' };
    }
    if (!Number.isInteger(toNationId) || toNationId <= 0) {
      return { ok: false, error: 'Destination nation ID must be a positive integer.' };
    }
    if (toNationId === fromNationId) {
      return { ok: false, error: 'Source and destination nation must be different.' };
    }
    const resources = normalizeBalance(resourcesInput);
    if (!hasAnyAmount(resources)) return { ok: false, error: 'Provide at least one positive resource amount.' };

    const current = await this._db.getNationBankBalance(guildId, fromNationId);
    for (const key of BANKING_RESOURCE_KEYS) {
      if (resources[key] > current[key]) {
        return { ok: false, error: `Insufficient ${key} balance.`, remaining: current };
      }
    }

    const ledger = await this._db.createBankingLedgerEntry({
      guild_id: guildId,
      nation_id: fromNationId,
      type: 'internal-transfer',
      status: 'pending',
      resources,
      source_transaction_id: null,
      idempotency_key: `internal-transfer:${guildId}:${fromNationId}:${toNationId}:${Date.now()}`,
      note: note || `Internal transfer from nation ${fromNationId} to nation ${toNationId} (${balanceToNote(resources)})`,
      actor_discord_id: actorDiscordId,
      error: null,
    });

    const debited = await this._db.debitNationBankBalance(guildId, fromNationId, resources);
    if (!debited.ok) {
      await this._db.updateBankingLedgerStatus(
        ledger.ledger_id,
        'failed',
        'Balance changed before the transfer could be applied.'
      );
      return { ok: false, error: 'Insufficient balance.', remaining: debited.balance };
    }

    try {
      await this._db.creditNationBankBalance(guildId, toNationId, resources);
    } catch (error) {
      // Credit failed after the debit already succeeded — refund the sender
      // immediately so the internal books stay balanced, and flag the ledger
      // entry for manual review.
      await this._db.creditNationBankBalance(guildId, fromNationId, resources);
      await this._db.updateBankingLedgerStatus(
        ledger.ledger_id,
        'failed',
        `Credit to destination nation failed; sender was refunded. ${toErrorMessage(error)}`
      );
      return { ok: false, error: 'Transfer failed; your balance was not changed.' };
    }

    await this._db.updateBankingLedgerStatus(ledger.ledger_id, 'completed');
    return { ok: true, remaining: debited.balance };
  }

  /**
   * Withdraws from the alliance's unregistered/unallocated pool balance (i.e. money
   * held on behalf of the alliance itself, not any single tracked nation) out to a
   * chosen nation. Distinct from withdrawToNation, which only ever debits the
   * calling member's own tracked balance — this debits the shared alliance pool,
   * so it should be gated to leaders/gov in the command layer.
   */
  async withdrawFromAlliancePool(
    guildId: string,
    resourcesInput: Partial<BankingResourceBalance>,
    actorDiscordId: string,
    destinationNationId: number
  ): Promise<{ ok: true; remaining: BankingResourceBalance } | { ok: false; error: string; remaining?: BankingResourceBalance }> {
    const cfg = await this._db.getBankingConfig(guildId);
    if (!cfg.enabled) return { ok: false, error: 'Banking is currently disabled for this guild.' };
    if (!cfg.bot_key) return { ok: false, error: 'Banking configuration is missing bot_key.' };
    const offshoreKey = this._resolveApiKey(cfg.offshore_api_key_ref);
    if (!offshoreKey) return { ok: false, error: 'Offshore API key is not configured.' };
    if (!Number.isInteger(destinationNationId) || destinationNationId <= 0) {
      return { ok: false, error: 'Destination nation ID must be a positive integer.' };
    }
    const resources = normalizeBalance(resourcesInput);
    if (!hasAnyAmount(resources)) return { ok: false, error: 'Provide at least one positive resource amount.' };
    const current = await this._db.getAlliancePoolBalance(guildId);
    for (const key of BANKING_RESOURCE_KEYS) {
      if (resources[key] > current[key]) {
        return { ok: false, error: `Insufficient alliance pool ${key} balance.`, remaining: current };
      }
    }

    const offshoreClient = this._clientFactory(offshoreKey);
    const ledger = await this._db.createBankingLedgerEntry({
      guild_id: guildId,
      nation_id: destinationNationId,
      type: 'alliance-pool-withdraw',
      status: 'pending',
      resources,
      source_transaction_id: null,
      idempotency_key: `alliance-pool-withdraw:${guildId}:${destinationNationId}:${Date.now()}`,
      note: `Withdraw from alliance pool to nation ${destinationNationId} (${balanceToNote(resources)})`,
      actor_discord_id: actorDiscordId,
      error: null,
    });
    try {
      const transfer = await offshoreClient.bankWithdraw({
        receiverId: destinationNationId,
        receiverType: 1,
        resources,
        note: `bar3-alliance-pool-withdraw ->${destinationNationId}`,
      });
      const debited = await this._db.debitAlliancePoolBalance(guildId, resources);
      if (!debited.ok) {
        await this._db.updateBankingLedgerStatus(
          ledger.ledger_id,
          'failed',
          `Transfer ${transfer.id} succeeded but alliance pool debit failed. Manual reconcile required.`
        );
        return { ok: false, error: 'Withdrawal transfer succeeded but pool balance update failed. Staff has been alerted.' };
      }
      await this._db.updateBankingLedgerStatus(ledger.ledger_id, 'completed');
      return { ok: true, remaining: debited.balance };
    } catch (error) {
      await this._db.updateBankingLedgerStatus(ledger.ledger_id, 'failed', toErrorMessage(error));
      return { ok: false, error: toErrorMessage(error) };
    }
  }

  async manualSendToOffshore(
    guildId: string,
    resourcesInput: Partial<BankingResourceBalance>,
    actorDiscordId: string,
    note: string | null
  ): Promise<{ ok: true; pool: BankingResourceBalance } | { ok: false; error: string }> {
    const cfg = await this._db.getBankingConfig(guildId);
    if (!cfg.enabled) return { ok: false, error: 'Banking is currently disabled for this guild.' };
    const offshoreAllianceId = await this._db.getGlobalOffshoreAllianceId(this._defaults.offshoreAllianceId);
    if (!offshoreAllianceId) return { ok: false, error: 'Offshore alliance ID is not configured.' };
    if (!cfg.bot_key) return { ok: false, error: 'Banking configuration is missing bot_key.' };
    const allianceBankKey = this._resolveConfiguredApiKey(cfg.alliance_bank_api_key_ref);
    if (!allianceBankKey) return { ok: false, error: 'Guild alliance-bank API key is not configured.' };

    const resources = normalizeBalance(resourcesInput);
    if (!hasAnyAmount(resources)) return { ok: false, error: 'Provide at least one positive resource amount.' };
    const client = this._clientFactory(allianceBankKey);
    const ledger = await this._db.createBankingLedgerEntry({
      guild_id: guildId,
      nation_id: null,
      type: 'manual-offshore',
      status: 'pending',
      resources,
      source_transaction_id: null,
      idempotency_key: `manual-offshore:${guildId}:${Date.now()}`,
      note: note || `Manual offshore forward (${balanceToNote(resources)})`,
      actor_discord_id: actorDiscordId,
      error: null,
    });
    try {
      await client.bankWithdraw({
        receiverId: offshoreAllianceId,
        receiverType: 2,
        resources,
        note: note ?? 'bar3-manual-offshore',
      });
      const credited = await this._creditOffshoredDeposits(guildId, resources);
      await this._db.updateBankingLedgerStatus(ledger.ledger_id, 'completed');
      return { ok: true, pool: credited.alliancePool };
    } catch (error) {
      await this._db.updateBankingLedgerStatus(ledger.ledger_id, 'failed', toErrorMessage(error));
      return { ok: false, error: toErrorMessage(error) };
    }
  }

  /**
   * Sends EVERY currently-pending deposit for this guild to the offshore
   * alliance in a single transfer, triggered by the "Send All to Offshore"
   * button. Only deposits that are still 'pending' at the moment this runs
   * are included, so nothing already sent gets double-processed.
   *
   * If the transfer to the offshore alliance fails, nothing is persisted as
   * sent: the pending deposit ledger entries are left untouched (still
   * 'pending') so they remain available to retry, and only the internal
   * bookkeeping entry for this attempt is marked 'failed'. Deposits are only
   * marked 'completed' — i.e. only "saved" as sent — once the offshore
   * transfer has actually succeeded.
   */
  async sendAllPendingDepositsToOffshore(
    guildId: string,
    actorDiscordId: string
  ): Promise<
    | { ok: true; pool: BankingResourceBalance; sentLedgerIds: string[] }
    | { ok: false; error: string }
  > {
    const pendingDeposits = await this._db.getBankingLedgerByTypeAndStatus(guildId, 'deposit', 'pending', 500);
    if (pendingDeposits.length === 0) {
      return { ok: false, error: 'No pending deposits to send.' };
    }
    const total = pendingDeposits.reduce(
      (sum, deposit) => addBalance(sum, normalizeBalance(deposit.resources)),
      emptyBalance()
    );
    if (!hasAnyAmount(total)) {
      return { ok: false, error: 'No pending deposits to send.' };
    }
    const sentLedgerIds = pendingDeposits.map((d) => d.ledger_id);
    const result = await this.manualSendToOffshore(
      guildId,
      total,
      actorDiscordId,
      `Sent via "Send All to Offshore" button (${sentLedgerIds.length} deposit(s))`
    );
    if (!result.ok) return result;
    return { ok: true, pool: result.pool, sentLedgerIds };
  }

  async getAlliancePoolVisibility(guildId: string): Promise<BankingResourceBalance> {
    return this._db.getAlliancePoolBalance(guildId);
  }

  async getAllNationBalances(guildId: string): Promise<NationBankBalanceWithRegistrationDoc[]> {
    return this._db.getAllNationBankBalances(guildId);
  }

  async getMemberVisibility(guildId: string, nationId: number): Promise<{
    nationBalance: BankingResourceBalance;
    alliancePool: BankingResourceBalance;
    lastActivity: Pick<BankingLedgerDoc, 'ledger_id' | 'type' | 'status' | 'created_at' | 'updated_at' | 'error'> | null;
  }> {
    const nationBalance = await this._db.getNationBankBalance(guildId, nationId);
    const alliancePool = await this._db.getAlliancePoolBalance(guildId);
    const latest = await this._db.getLatestBankingActivity(guildId, nationId);
    return {
      nationBalance,
      alliancePool,
      lastActivity: latest
        ? {
          ledger_id: latest.ledger_id,
          type: latest.type,
          status: latest.status,
          created_at: latest.created_at,
          updated_at: latest.updated_at,
          error: latest.error,
        }
        : null,
    };
  }
}
