          .setDescription(lines.join('\n'))
          .setColor(0xFF9500)
          .setFooter({ text: `${wrong.length} member(s) on wrong color · ${members.length} total checked · expected: ${expected.charAt(0).toUpperCase() + expected.slice(1)}` });
        return void interaction.followUp({ embeds: [embed] });
      }
      if (commandName === 'damage_leaderboard') {
        if (!interaction.guildId) return void interaction.reply({ content: 'Guild only command.', flags: MessageFlags.Ephemeral });
        if (!await hasMemberAccess(interaction, db)) return void interaction.reply({ content: 'You need the Member role to use this command.', flags: MessageFlags.Ephemeral });
        const allianceId = await db.getAllianceId(BigInt(interaction.guildId));
        if (!allianceId) return void interaction.reply({ content: 'Primary alliance is not configured.', flags: MessageFlags.Ephemeral });
        await interaction.deferReply();
        const after = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
        let damageData: Map<number, Record<string, unknown>>;
        let prices: import('./pnw_api').TradePrice;
        let allMembers: Nation[];
        try {
          [damageData, prices, allMembers] = await Promise.all([
            pnw.getAllianceDamage(allianceId, after),
            pnw.getTradePrices().catch(() => ({ gasoline: 2000, munitions: 1800, aluminum: 3200, steel: 4000 })),
            pnw.getAllianceMembers([allianceId]).catch(() => [] as Nation[]),
          ]);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return void interaction.followUp({ embeds: [new EmbedBuilder().setDescription(`❌ Could not reach the Politics and War API: ${msg}`).setColor(0xE74C3C)] });
        }
        // Include all current members (even zero-damage ones)
        for (const member of allMembers) {
          if (!damageData.has(member.nationId)) {
            damageData.set(member.nationId, {
              nation_name: member.nationName, num_cities: member.numCities,
              infra_value: 0, money_looted: 0, gas_looted: 0, mun_looted: 0,
              alum_looted: 0, steel_looted: 0, def_gas_used: 0, def_mun_used: 0,
              def_alum_used: 0, def_steel_used: 0, def_soldiers_killed: 0,
              def_tanks_killed: 0, def_aircraft_killed: 0, def_ships_sunk: 0,
            });
          }
        }
        if (!damageData.size) return void interaction.followUp({ embeds: [new EmbedBuilder().setDescription('ℹ️ No members found for the configured alliance.').setColor(0x3498DB)] });

        const fmtK = (v: number) => {
          if (Math.abs(v) >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`;
          if (Math.abs(v) >= 10_000) return `$${(v / 1_000).toFixed(0)}K`;
          return `$${v.toFixed(0)}`;
        };
        const calcMetrics = (e: Record<string, unknown>) => {
          const n = (x: unknown) => Number(x ?? 0);
          const infra = n(e['infra_value']);
          const resDmg =
            (n(e['def_gas_used']) + n(e['gas_looted'])) * prices.gasoline +
            (n(e['def_mun_used']) + n(e['mun_looted'])) * prices.munitions +
            (n(e['def_alum_used']) + n(e['alum_looted'])) * prices.aluminum +
            (n(e['def_steel_used']) + n(e['steel_looted'])) * prices.steel +
            n(e['def_soldiers_killed']) * 5.0 +
            n(e['def_tanks_killed']) * (60.0 + 0.5 * prices.steel) +
            n(e['def_aircraft_killed']) * (4_000.0 + 10.0 * prices.aluminum) +
            n(e['def_ships_sunk']) * (50_000.0 + 30.0 * prices.steel);
          const loot = n(e['money_looted']) +
            n(e['gas_looted']) * prices.gasoline + n(e['mun_looted']) * prices.munitions +
            n(e['alum_looted']) * prices.aluminum + n(e['steel_looted']) * prices.steel;
          const total = infra + resDmg;
          const cities = Math.max(1, n(e['num_cities']));
          return { infra, resDmg, loot, total, dmgCity: total / cities };
        };

        const SORT_MODES = ['total', 'loot', 'dmg_city', 'infra', 'res_dmg'] as const;
        type SortMode = typeof SORT_MODES[number];
        const SORT_LABELS: Record<SortMode, string> = { total: '📊 Total', loot: '💰 Loot', dmg_city: '💥 /City', infra: '🏗️ Infra', res_dmg: '💥 Res Dmg' };
        const LB_PAGE_SIZE = 10;

        const allNations = Array.from(damageData.entries());
        let sortMode: SortMode = 'total';
        let lbPage = 0;

        const getSorted = () => [...allNations].sort((a, b) => {
          const ma = calcMetrics(a[1]);
          const mb = calcMetrics(b[1]);
          return mb[sortMode === 'dmg_city' ? 'dmgCity' : sortMode === 'res_dmg' ? 'resDmg' : sortMode as 'total'|'loot'|'infra'] -
                 ma[sortMode === 'dmg_city' ? 'dmgCity' : sortMode === 'res_dmg' ? 'resDmg' : sortMode as 'total'|'loot'|'infra'];
        });

        const buildLbEmbed = (sorted: [number, Record<string, unknown>][], pg: number, sm: SortMode) => {
          const total = sorted.length;
          const totalPages = Math.max(1, Math.ceil(total / LB_PAGE_SIZE));
          const safePg = Math.max(0, Math.min(pg, totalPages - 1));
          const chunk = sorted.slice(safePg * LB_PAGE_SIZE, (safePg + 1) * LB_PAGE_SIZE);
          const lines = chunk.map(([nationId, e], idx) => {
            const rank = safePg * LB_PAGE_SIZE + idx + 1;
            const m = calcMetrics(e);
            const cities = Math.max(1, Number(e['num_cities'] ?? 1));
            const name = String(e['nation_name'] ?? nationId);
            const bold = (s: string, active: boolean) => active ? `**${s}**` : s;
            const stats = [
              bold(`📊 ${fmtK(m.total)} (${fmtK(m.total / cities)}/c)`, sm === 'total' || sm === 'dmg_city'),
              bold(`🏗️ ${fmtK(m.infra)}`, sm === 'infra'),
              bold(`💥 ${fmtK(m.resDmg)}`, sm === 'res_dmg'),
              bold(`💰 ${fmtK(m.loot)}`, sm === 'loot'),
            ].join('  ');
            return `**${rank}.** [${name}](${nationUrl(nationId)})  ·  ${cities}🏙️\n${stats}`;
          });
          const footerParts = [`Sorted: ${SORT_LABELS[sm]}`, `Page ${safePg + 1}/${totalPages}`, `${total} members`, `g:${Math.round(prices.gasoline)} m:${Math.round(prices.munitions)} a:${Math.round(prices.aluminum)} s:${Math.round(prices.steel)} ppu`];
          return new EmbedBuilder()
            .setTitle(`⚔️ War Leaderboard — Past 7 Days`)
            .setDescription(lines.join('\n\n') || '*No data.*')
            .setColor(0xF1C40F)
            .setFooter({ text: footerParts.join('  ·  ') });
        };

        const buildLbRow = (sorted: [number, Record<string, unknown>][], pg: number, sm: SortMode) => {
          const totalPages = Math.max(1, Math.ceil(sorted.length / LB_PAGE_SIZE));
          const sortRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
            ...SORT_MODES.map(mode =>
              new ButtonBuilder().setCustomId(`lb_sort_${mode}`).setLabel(SORT_LABELS[mode]).setStyle(mode === sm ? ButtonStyle.Primary : ButtonStyle.Secondary)
            )
          );
          const navRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder().setCustomId('lb_prev').setLabel('◀').setStyle(ButtonStyle.Secondary).setDisabled(pg === 0),
            new ButtonBuilder().setCustomId('lb_next').setLabel('▶').setStyle(ButtonStyle.Secondary).setDisabled(pg >= totalPages - 1),
          );
          return totalPages > 1 ? [sortRow, navRow] : [sortRow];
        };

        let sorted = getSorted();
        const lbMsg = await interaction.followUp({ embeds: [buildLbEmbed(sorted, lbPage, sortMode)], components: buildLbRow(sorted, lbPage, sortMode) });
        const lbCollector = lbMsg.createMessageComponentCollector({ componentType: ComponentType.Button, time: 600_000 });
        lbCollector.on('collect', async (btn) => {
          try {
            // Acknowledge the component immediately. Any work after this point can
            // safely exceed Discord's ~3 second initial-response window.
            if (btn.user.id !== interaction.user.id) {
              await btn.reply({ content: 'Only the command caller can use these buttons.', flags: MessageFlags.Ephemeral });
              return;
            }
            await btn.deferUpdate();

            if (btn.customId.startsWith('lb_sort_')) {
              sortMode = btn.customId.replace('lb_sort_', '') as SortMode;
              lbPage = 0;
              sorted = getSorted();
            } else if (btn.customId === 'lb_prev' && lbPage > 0) {
              lbPage -= 1;
            } else if (btn.customId === 'lb_next') {
              lbPage += 1;
            }

            await lbMsg.edit({
              embeds: [buildLbEmbed(sorted, lbPage, sortMode)],
              components: buildLbRow(sorted, lbPage, sortMode),
            });
          } catch (err) {
            // Do not turn transient Discord/API failures into unhandled rejections.
            console.error('Failed to handle damage leaderboard button:', err);
          }
        });
        lbCollector.on('end', async () => { try { await interaction.editReply({ components: [] }); } catch { /**/ } });
        return;
      }


      if (commandName === 'welcome_set') {
        if (!interaction.guildId) return void interaction.reply({ content: 'Guild only command.', flags: MessageFlags.Ephemeral });
        if (!await hasGovAccess(interaction, db, ['ia','leader','2ic'])) return void interaction.reply({ content: 'Missing permissions.', flags: MessageFlags.Ephemeral });
        const message = interaction.options.getString('message', true);
        await db.setWelcomeConfig(BigInt(interaction.guildId), { message });
        return void interaction.reply({ content: 'Welcome message updated.' });
      }
      if (commandName === 'welcome_channel_set') {
        if (!interaction.guildId) return void interaction.reply({ content: 'Guild only command.', flags: MessageFlags.Ephemeral });
        if (interaction.commandName === 'chanel_set') {
          if (!hasAdminCommandAccess(interaction)) return void interaction.reply({ content: 'Missing permissions.', flags: MessageFlags.Ephemeral });
        } else if (!await hasGovAccess(interaction, db, ['ia','leader','2ic'])) return void interaction.reply({ content: 'Missing permissions.', flags: MessageFlags.Ephemeral });