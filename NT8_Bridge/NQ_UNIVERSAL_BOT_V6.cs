// ═══════════════════════════════════════════════════════════════════════════
// Copyright (c) 2026 Sahajpal Rai. All Rights Reserved.
// ───────────────────────────────────────────────────────────────────────────
// PROPRIETARY AND CONFIDENTIAL
//
// This software and its source code are the exclusive property of the owner.
// Unauthorized copying, reproduction, distribution, modification, reverse
// engineering, or any form of use — in whole or in part — without the express
// written permission of the owner is strictly prohibited and may result in
// civil and criminal penalties.
//
// NQ UNIVERSAL BOT V6 — NinjaTrader 8 Executor
// For personal use only. Not for resale or redistribution.
// 2026-05-21: ManageExits race fix — guard flat-reset with !_positionOpen
//   (zeroing _entrySlPoints pre-fill was disabling BE+trail every trade)
// 2026-05-21: TAGGED SetStopLoss fix — BE/trail must use same tag as entry ("V6_LONG"/"V6_SHORT")
//   NT8 tagless SetStopLoss does NOT modify a tagged stop order — stop was silently staying at original SL
// 2026-05-21: _cachedSlPrice reset fix — added reset in flat-block and SubmitOrder so trail advance
//   never compares against a stale SL price from a previous trade
// ═══════════════════════════════════════════════════════════════════════════

#region Using declarations
using System;
using System.ComponentModel;
using System.ComponentModel.DataAnnotations;
using System.Globalization;
using System.IO;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using NinjaTrader.Cbi;
using NinjaTrader.Data;
using NinjaTrader.Gui;
using NinjaTrader.NinjaScript;
using NinjaTrader.NinjaScript.DrawingTools;
using NinjaTrader.NinjaScript.Strategies;
#endregion

namespace NinjaTrader.NinjaScript.Strategies
{
    // ═══════════════════════════════════════════════════════════════════════════
    // NQ_UNIVERSAL_BOT_V6
    // ═══════════════════════════════════════════════════════════════════════════
    // One strategy for all charts: NQ, ES, CL, GC and their micros.
    // Set SignalFilePath per chart to the matching signal file:
    //   NQ  -> ml_signals\v6_nq_signal.json
    //   ES  -> ml_signals\v6_es_signal.json
    //   MNQ -> ml_signals\v6_mnq_signal.json
    //   MES -> ml_signals\v6_mes_signal.json
    //
    // Exit management (dynamic mode — May 18 baseline, SHORT BE fixed 2026-05-21):
    //   Stage 1 — Break-even: SL snaps to entry ± BeBufferTicks when profit >= beTicks
    //   Stage 2 — Tight trail: activates at plTicks profit, advances every bar
    //   Fixed tick values per instrument (3-level fallback: JSON → property → default):
    //     NQ / MNQ:  BE=32t (8 pts)   PL start=36t (9 pts)   Trail step=30t (7.5 pts)
    //     ES / MES:  BE=8t  (2 pts)   PL start=12t (3 pts)   Trail step=4t  (1 pt)
    //   SHORT BE: stop at entryPx − BeBufferTicks (below entry = profit lock, above current market)
    // ═══════════════════════════════════════════════════════════════════════════
    public class NQ_UNIVERSAL_BOT_V6 : Strategy
    {
        // ─── Signal state ───────────────────────────────────────────────────
        private string   sigAction      = "FLAT";
        private double   sigLongProb    = 0.0;
        private double   sigShortProb   = 0.0;
        private double   sigTpPoints    = 0.0;
        private double   sigSlPoints    = 0.0;
        private double   sigAtr         = 0.0;
        private double   sigClose       = 0.0;
        private string   sigRegime      = "";
        private bool     sigWarmup      = true;
        private bool     sigNewsBlocked = false;
        private string   sigNewsReason  = "";
        private string   sigTimestamp   = "";
        private int      sigTier        = 0;     // 1/2/3 from Python tier selection (0 = not set)
        private double   sigThLong      = 0.0;   // live long  threshold for this tier
        private double   sigThShort     = 0.0;   // live short threshold for this tier
        private string   sigTrend       = "";    // EMA gate direction: UP / DOWN / NEUTRAL
        private string   sigLastTradeLabel  = "";  // last trade gate label e.g. "EM | T2 | ^UP"
        private string   sigLastTradeAction = "";  // last trade action: BUY / SELL
        private DateTime lastFileWrite  = DateTime.MinValue;
        private string   lastSignalFired= "";
        private bool     _positionOpen  = false;  // set true in SubmitOrder; cleared by OnExecutionUpdate when position goes flat — bridges the 1-tick race between order submission and fill confirmation

        // ─── Trade tracking ─────────────────────────────────────────────────
        private string   atmStrategyId     = "";
        private string   atmOrderId        = "";
        private bool     atmInFlight       = false;
        private int      todayTrades       = 0;
        private DateTime todayDate         = DateTime.MinValue;
        private DateTime strategyStartTime = DateTime.MinValue;

        // ─── Exit management (dynamic mode) ─────────────────────────────────
        private bool   beApplied      = false;
        private bool   plApplied      = false;
        private double _entrySlPoints = 0;   // SL distance (pts) captured at entry — used for ATR-proportional trail

        // ─── EOD force-flat (1:58 PM PT / 4:58 PM ET = 20:58 UTC) ───────────
        private bool _eodCloseFired = false;  // reset each day after 22:00 UTC (6 PM ET)

        // ─── Chart lines (TP / SL / BE / Trail) ─────────────────────────────
        private int  _tpTicks    = 0;
        private int  _slTicks    = 0;
        private bool _linesDrawn = false;

        // ─── UI panel ───────────────────────────────────────────────────────
        private Border    panelBorder;
        private TextBlock panelText;
        private TextBlock _titleBlock;
        private bool      _isDragging   = false;
        private double    _dragOffsetX  = 0.0;
        private double    _dragOffsetY  = 0.0;
        private Canvas    _overlayCanvas = null;

        // ═══════════════════════════════════════════════════════════════════
        // PROPERTIES
        // ═══════════════════════════════════════════════════════════════════

        // 01. Signal
        [NinjaScriptProperty]
        [Display(Name = "Signal File Path", Order = 0, GroupName = "01. Signal")]
        public string SignalFilePath { get; set; }

        [NinjaScriptProperty]
        [Display(Name = "Max Stale Seconds (heartbeat age)", Order = 1, GroupName = "01. Signal")]
        public int MaxStaleSecs { get; set; }

        // 02. Orders
        [NinjaScriptProperty]
        [Display(Name = "ATM Strategy Name", Order = 0, GroupName = "02. Orders")]
        public string AtmStrategyName { get; set; }

        [NinjaScriptProperty]
        [Display(Name = "Contract Size", Order = 1, GroupName = "02. Orders")]
        public int ContractSize { get; set; }

        [NinjaScriptProperty]
        [Display(Name = "USE DYNAMIC EXIT: BE + Trail  [UNCHECK = use ATM Strategy template]", Order = 2, GroupName = "02. Orders")]
        public bool UseDynamicTpSl { get; set; }

        [NinjaScriptProperty]
        [Display(Name = "Use Trail Stop within Dynamic Exit (OFF = BE only, no trail)", Order = 3, GroupName = "02. Orders")]
        public bool UseTrailStop { get; set; }

        [NinjaScriptProperty]
        [Range(0, 40)]
        [Display(Name = "Break-Even Buffer Ticks (stop above/below entry at BE)", Order = 4, GroupName = "02. Orders")]
        public int BeBufferTicks { get; set; }

        [NinjaScriptProperty]
        [Range(0, 200)]
        [Display(Name = "NQ BE Trigger Ticks (0 = default 32t)", Order = 5, GroupName = "02. Orders")]
        public int NqBeTicks { get; set; }

        [NinjaScriptProperty]
        [Range(0, 200)]
        [Display(Name = "NQ Trail Start Ticks (0 = default 36t)", Order = 6, GroupName = "02. Orders")]
        public int NqPlTicks { get; set; }

        [NinjaScriptProperty]
        [Range(0, 200)]
        [Display(Name = "NQ Trail Step Ticks (0 = default 30t)", Order = 7, GroupName = "02. Orders")]
        public int NqTrailTicks { get; set; }

        [NinjaScriptProperty]
        [Range(0, 200)]
        [Display(Name = "ES BE Trigger Ticks (0 = default 8t)", Order = 8, GroupName = "02. Orders")]
        public int EsBeTicks { get; set; }

        [NinjaScriptProperty]
        [Range(0, 200)]
        [Display(Name = "ES Trail Start Ticks (0 = default 12t)", Order = 9, GroupName = "02. Orders")]
        public int EsPlTicks { get; set; }

        [NinjaScriptProperty]
        [Range(0, 200)]
        [Display(Name = "ES Trail Step Ticks (0 = default 4t)", Order = 10, GroupName = "02. Orders")]
        public int EsTrailTicks { get; set; }

        // 03. Eval / Prop Firm
        [NinjaScriptProperty]
        [Display(Name = "Eval Config Path",
                 Order = 0, GroupName = "05. Eval",
                 Description = "Path to v6_eval_config.json written by web dashboard. " +
                               "Strategy reads daily loss/profit limits every 30 s and silently " +
                               "blocks new entries when a limit is hit — independent of dashboard.")]
        public string EvalConfigPath { get; set; }

        [NinjaScriptProperty]
        [Display(Name = "Exit Config Path (NQ BE/Trail overrides from dashboard)",
                 Order = 1, GroupName = "05. Eval",
                 Description = "Path to v6_exit_config.json written by web dashboard Settings tab. " +
                               "Overrides NQ break-even and trail ticks live every 30 s — no recompile needed. " +
                               "Set to 0 in JSON to fall back to NT8 Properties, then coded defaults.")]
        public string ExitConfigPath { get; set; }

        // ═══════════════════════════════════════════════════════════════════
        // INITIALIZE
        // ═══════════════════════════════════════════════════════════════════
        protected override void OnStateChange()
        {
            if (State == State.SetDefaults)
            {
                Description         = "V6 Universal Bot — reads Python ML signal JSON, fires orders.";
                Name                = "NQ_UNIVERSAL_BOT_V6";
                Calculate           = Calculate.OnEachTick;
                EntriesPerDirection = 1;
                IsExitOnSessionCloseStrategy = true;

                SignalFilePath       = @"D:\Claud Folder\V6\ml_signals\v6_nq_signal.json";
                MaxStaleSecs         = 360;
                AtmStrategyName      = "RK-Sys Platinum # NQ";
                ContractSize         = 1;
                UseDynamicTpSl       = true;
                UseTrailStop         = true;
                BeBufferTicks        = 10;
                NqBeTicks            = 0;   // 0 = use default 32t
                NqPlTicks            = 0;   // 0 = use default 36t
                NqTrailTicks         = 0;   // 0 = use default 30t
                EsBeTicks            = 0;   // 0 = use default 8t
                EsPlTicks            = 0;   // 0 = use default 12t
                EsTrailTicks         = 0;   // 0 = use default 4t
                EvalConfigPath       = @"D:\Claud Folder\V6\ml_signals\v6_eval_config.json";
                ExitConfigPath       = @"D:\Claud Folder\V6\ml_signals\v6_exit_config.json";
            }
            else if (State == State.DataLoaded)
            {
                // ── Trend gate EMAs ───────────────────────────────────────────────
                if (ChartControl != null)
                {
                    var ema45 = EMA(45);
                    ema45.Plots[0].Brush = Brushes.White;
                    ema45.Plots[0].Width = 2.5f;
                    AddChartIndicator(ema45);

                    var ema100 = EMA(100);
                    ema100.Plots[0].Brush = Brushes.LimeGreen;
                    ema100.Plots[0].Width = 2.5f;
                    AddChartIndicator(ema100);

                    var ema250 = EMA(250);
                    ema250.Plots[0].Brush = Brushes.Goldenrod;
                    ema250.Plots[0].Width = 1.5f;
                    AddChartIndicator(ema250);
                }
            }
            else if (State == State.Realtime)
            {
                strategyStartTime = DateTime.UtcNow;
            }
            else if (State == State.Terminated)
            {
                if (!string.IsNullOrEmpty(atmStrategyId))
                {
                    try { AtmStrategyClose(atmStrategyId); } catch { }
                    atmStrategyId = "";
                }
                if (ChartControl != null && panelBorder != null)
                {
                    try
                    {
                        ChartControl.Dispatcher.InvokeAsync(() =>
                        {
                            if (_overlayCanvas != null)
                                _overlayCanvas.Children.Remove(panelBorder);
                            else
                            {
                                var p2 = panelBorder.Parent as Panel;
                                if (p2 != null) p2.Children.Remove(panelBorder);
                            }
                        });
                    }
                    catch { }
                }
            }
        }

        // ═══════════════════════════════════════════════════════════════════
        // MAIN BAR UPDATE
        // ═══════════════════════════════════════════════════════════════════
        protected override void OnBarUpdate()
        {
            if (State != State.Realtime) return;
            if (CurrentBar < 5)          return;

            // Reset daily trade counter at midnight
            if (Time[0].Date != todayDate)
            {
                todayDate   = Time[0].Date;
                todayTrades = 0;
            }

            // Read signal, manage active position, refresh UI
            ReadSignalFile();
            ReadEvalConfig();
            ReadExitConfig();

            // ── Eval gate — recompute every bar against current realized P&L ───
            if (_evalOn)
            {
                double rPnl = 0.0;
                try { rPnl = Account.Get(AccountItem.RealizedProfitLoss, Currency.UsDollar); } catch { }
                _evalBlocked      = rPnl <= -_evalLLimit;
                _evalProfitLocked = _evalDrawdown && rPnl >= _evalPTarget;
            }
            else { _evalBlocked = false; _evalProfitLocked = false; }

            // ── EOD Force-Flat: 1:58 PM PT / 4:58 PM ET (20:58 UTC) ─────────
            // Hard-close any open position 2 min before the CME 5 PM ET
            // maintenance break — no matter profit or loss.
            // Flag resets after 22:00 UTC so ETH session trades normally.
            {
                DateTime _utcEod = DateTime.UtcNow;
                if (_eodCloseFired && _utcEod.Hour >= 22) _eodCloseFired = false;

                bool _eodNow = (_utcEod.Hour == 20 && _utcEod.Minute >= 58)
                            ||  _utcEod.Hour == 21;

                if (_eodNow && !_eodCloseFired)
                {
                    _eodCloseFired = true;
                    var _mpEod = Position.MarketPosition;
                    if (_mpEod != MarketPosition.Flat)
                    {
                        Print(string.Format(CultureInfo.InvariantCulture,
                            "V6 EOD CLOSE [{0}]: force-flat {1} x{2} @ {3:HH:mm:ss} UTC  (1:58 PM PT rule)",
                            Instrument.FullName, _mpEod, Position.Quantity, _utcEod));
                        try
                        {
                            // Cancel ATM bracket first (removes pending stop/target orders)
                            if (!string.IsNullOrEmpty(atmStrategyId))
                                try { AtmStrategyClose(atmStrategyId); } catch { }

                            // Market exit for the raw position
                            if (_mpEod == MarketPosition.Long)
                                ExitLong(Position.Quantity,  "V6_EOD_CLOSE", "V6_LONG");
                            else
                                ExitShort(Position.Quantity, "V6_EOD_CLOSE", "V6_SHORT");
                        }
                        catch (Exception ex)
                        {
                            Print("V6 EOD close FAILED — " + ex.Message);
                        }
                    }
                    else
                    {
                        Print(string.Format(CultureInfo.InvariantCulture,
                            "V6 EOD [{0}]: already flat @ {1:HH:mm} UTC — no action",
                            Instrument.FullName, _utcEod));
                    }
                }
            }

            ManageExits();
            UpdatePanel();

            // Write P&L file: 5 s when in a position (live float), 30 s when flat
            double pnlInterval = Position.MarketPosition != MarketPosition.Flat ? 5.0 : 30.0;
            if ((DateTime.UtcNow - _lastPnlWrite).TotalSeconds >= pnlInterval)
            {
                WritePnlFile();
                _lastPnlWrite = DateTime.UtcNow;
            }

            // Write position file every 5 s for V6_PositionDisplay on other charts
            if ((DateTime.UtcNow - _lastPosWrite).TotalSeconds >= 5)
            {
                WritePositionFile();
                _lastPosWrite = DateTime.UtcNow;
            }

            // ── Gate: skip new entries ──────────────────────────────────────
            if (sigWarmup)           return;
            if (sigAction == "FLAT") return;

            // No new entries from 1:45 PM PT / 4:45 PM ET (20:45 UTC) onward.
            // Position force-close still fires separately at 1:58 PM PT (20:58 UTC).
            { int _eh = DateTime.UtcNow.Hour; int _em = DateTime.UtcNow.Minute;
              if ((_eh == 20 && _em >= 45) || _eh == 21) return; }

            if (strategyStartTime == DateTime.MinValue) return;

            // Startup protection: ignore signals that pre-date strategy start
            DateTime sigDt;
            if (DateTime.TryParse(sigTimestamp, CultureInfo.InvariantCulture,
                DateTimeStyles.AdjustToUniversal | DateTimeStyles.AssumeUniversal, out sigDt))
            {
                if (sigDt < strategyStartTime) return;
            }

            // Deduplication
            string sigKey = sigTimestamp + "_" + sigAction;
            if (sigKey == lastSignalFired) return;

            // News block — skip new entries only (existing position still managed above)
            if (sigNewsBlocked) return;

            // Must be flat before entering
            if (Position.MarketPosition != MarketPosition.Flat) return;
            // Secondary guard: prevents re-entry during the 1-tick window between
            // SubmitOrder and the fill being confirmed by OnExecutionUpdate.
            // Without this, a new signal with a different timestamp (new sigKey)
            // can pass the Position check before the fill propagates, causing
            // SetStopLoss/SetProfitTarget to overwrite the active bracket.
            if (_positionOpen) return;

            // ATM guard
            if (atmInFlight) return;
            if (!string.IsNullOrEmpty(atmStrategyId))
            {
                try
                {
                    if (GetAtmStrategyMarketPosition(atmStrategyId) != MarketPosition.Flat) return;
                }
                catch { atmStrategyId = ""; }
            }

            // Eval / Prop firm gate — silently block new entries when daily limit hit
            if (_evalBlocked || _evalProfitLocked) return;

            // ── EXECUTE ──
            bool isLong = sigAction == "BUY";

            lastSignalFired = sigKey;
            todayTrades++;

            Print(string.Format(CultureInfo.InvariantCulture,
                "V6 EXECUTE: {0}  long={1:F4}  short={2:F4}  regime={3}  tp={4:F2}  sl={5:F2}",
                sigAction, sigLongProb, sigShortProb, sigRegime, sigTpPoints, sigSlPoints));

            // Chart entry marker — fixed tag (overwrites previous) + IsAutoScale=false
            // to prevent Y-axis rescale on each placement (was causing blink, 2026-05-21)
            try
            {
                double y = isLong ? Low[0] - TickSize * 8 : High[0] + TickSize * 8;
                var marker = Draw.Text(this, "V6_ENTRY",
                                       isLong ? "▲" : "▼", 0, y,
                                       isLong ? Brushes.LimeGreen : Brushes.OrangeRed);
                if (marker != null) marker.IsAutoScale = false;
            }
            catch { }

            SubmitOrder(isLong);
            WritePnlFile();
            WritePositionFile();
            _lastPosWrite = DateTime.UtcNow;
        }

        // ═══════════════════════════════════════════════════════════════════
        // 2-STAGE EXIT MANAGEMENT  (May 18 baseline — SHORT BE corrected 2026-05-21)
        //
        // Stage 1 — Break-even: SL moves to entry ± BeBufferTicks when ticksIn >= beTicks
        //   LONG:  stop → entry + BeBufferTicks  (above entry = profit lock)
        //   SHORT: stop → entry − BeBufferTicks  (below entry = profit lock, above current market)
        //
        // Stage 2 — Tight trail: activates at plTicks, advances on every bar
        //
        // Fixed tick defaults (3-level fallback: dashboard JSON → property → coded default):
        //   NQ / MNQ:  BE=32t  PL start=36t  Trail step=30t
        //   ES / MES:  BE=8t   PL start=12t  Trail step=4t
        //
        // Only active when UseDynamicTpSl = true.
        // UseTrailStop must also be ON for trail stages to run;
        // bracket re-apply (after recompile mid-trade) runs regardless.
        // ═══════════════════════════════════════════════════════════════════
        private void ManageExits()
        {
            if (!UseDynamicTpSl) return;

            var mp = Position.MarketPosition;
            if (mp == MarketPosition.Flat)
            {
                // Guard: _positionOpen = true means order submitted but fill not yet confirmed.
                // During this 1-N tick window Position reports Flat, so WITHOUT this guard
                // _entrySlPoints (set by SubmitOrder) gets zeroed → ManageExits returns early
                // on every subsequent tick → BE and trail silently disabled for the entire trade.
                if (!_positionOpen)
                {
                    beApplied      = false;
                    plApplied      = false;
                    _linesDrawn    = false;
                    _bestPriceSeen = 0;
                    _entrySlPoints = 0;
                    _cachedSlPrice = 0;   // fix: stale SL from previous trade would break trail advance comparison
                }
                return;
            }

            // ── Bracket re-apply after recompile / re-add mid-trade ───────────
            // If strategy was re-added while a trade is open, SubmitOrder never ran,
            // so _tpTicks == 0. Restore the bracket orders so NT8 shows TP/SL lines.
            if (!_linesDrawn && _tpTicks == 0 && sigTpPoints > 0 && sigSlPoints > 0)
            {
                _slTicks       = Math.Max(4,            (int)Math.Round(sigSlPoints / TickSize));
                _tpTicks       = Math.Max(_slTicks + 4, (int)Math.Round(sigTpPoints / TickSize));
                _entrySlPoints = sigSlPoints;
                bool isLng = mp == MarketPosition.Long;
                string rtag = isLng ? "V6_LONG" : "V6_SHORT";
                double expStop = isLng
                    ? Position.AveragePrice - _slTicks * TickSize
                    : Position.AveragePrice + _slTicks * TickSize;
                bool stopOnCorrectSide = isLng ? (expStop < Close[0]) : (expStop > Close[0]);
                try { SetProfitTarget(CalculationMode.Ticks, _tpTicks); } catch { }
                if (stopOnCorrectSide)
                {
                    try
                    {
                        SetStopLoss(CalculationMode.Price, expStop);
                        Print(string.Format(CultureInfo.InvariantCulture,
                            "V6: Bracket re-applied -- TP={0}t  SL@{1:F2}  ({2})",
                            _tpTicks, expStop, isLng ? "LONG" : "SHORT"));
                    }
                    catch (Exception ex) { Print("V6: Re-apply stop failed -- " + ex.Message); }
                }
                else
                {
                    Print(string.Format(CultureInfo.InvariantCulture,
                        "V6: Re-apply SKIPPED -- stop {0:F2} wrong side of {1:F2}  ({2})",
                        expStop, Close[0], isLng ? "LONG" : "SHORT"));
                }
            }
            if (!_linesDrawn) _linesDrawn = true;

            // Use sigSlPoints as fallback: if _entrySlPoints was zeroed by race (pre-fill tick window),
            // sigSlPoints (always available from signal file) allows BE+trail to still run.
            if (_entrySlPoints <= 0 && sigSlPoints <= 0) return;

            // ── Per-instrument ATR-proportional percentages ───────────────────
            string instrRoot = Instrument.MasterInstrument.Name.ToUpperInvariant();
            bool   isEs      = instrRoot == "ES" || instrRoot == "MES";

            // Both ES and NQ use fixed ticks with 3-level fallback:
            //   dashboard JSON → NT8 property → coded default
            // ES defaults: BE=8t (2.0 pts)  Trail start=12t (3.0 pts)  Trail step=4t (1.0 pt)
            // NQ defaults: BE=32t (8.0 pts)  Trail start=36t (9.0 pts)  Trail step=30t (7.5 pts)
            // NOTE: ATR-percentage formula was removed for ES — BeBufferTicks=10 dominated
            //   the Math.Max() and pushed BE trigger to 12t (= full SL distance) making
            //   it almost never fire on typical ES trades.
            int beTicks, plTicks, trailTicks, beBuffer;
            if (isEs)
            {
                beTicks    = _exitCfgEsBeTicks    > 0 ? _exitCfgEsBeTicks
                           : EsBeTicks            > 0 ? EsBeTicks    : 8;   // default 2.0 pts
                plTicks    = _exitCfgEsPlTicks    > 0 ? _exitCfgEsPlTicks
                           : EsPlTicks            > 0 ? EsPlTicks    : 12;  // default 3.0 pts
                trailTicks = _exitCfgEsTrailTicks > 0 ? _exitCfgEsTrailTicks
                           : EsTrailTicks         > 0 ? EsTrailTicks : 4;   // default 1.0 pt
                beBuffer   = 1; // 1 tick buffer is perfect for ES (covers commissions + 0.25 pt profit lock)
            }
            else  // NQ / MNQ — 3-level fallback: dashboard JSON → NT8 property → coded default
            {
                beTicks    = _exitCfgBeTicks    > 0 ? _exitCfgBeTicks
                           : NqBeTicks          > 0 ? NqBeTicks    : 32;  // default 8.0 pts
                plTicks    = _exitCfgPlTicks    > 0 ? _exitCfgPlTicks
                           : NqPlTicks          > 0 ? NqPlTicks    : 36;  // default 9.0 pts
                trailTicks = _exitCfgTrailTicks > 0 ? _exitCfgTrailTicks
                           : NqTrailTicks       > 0 ? NqTrailTicks : 30;  // default 7.5 pts
                beBuffer   = 2; // 2 ticks buffer is perfect for NQ (covers commissions + 0.50 pt profit lock)
            }

            bool   isLong     = mp == MarketPosition.Long;
            double entryPx    = Position.AveragePrice;
            string tag        = isLong ? "V6_LONG" : "V6_SHORT";
            double barExtreme = isLong ? High[0] : Low[0];
            double ticksIn    = isLong
                ? (barExtreme - entryPx) / TickSize
                : (entryPx - barExtreme) / TickSize;

            // Track best intrabar price seen (High for LONG, Low for SHORT)
            if (isLong) { if (_bestPriceSeen == 0 || barExtreme > _bestPriceSeen) _bestPriceSeen = barExtreme; }
            else        { if (_bestPriceSeen == 0 || barExtreme < _bestPriceSeen) _bestPriceSeen = barExtreme; }

            // ── Stage 1 — Break-even snap (fires once) ────────────────────────
            // Stop moves to:
            //   LONG:  entry + beBuffer → above entry → locks in profit
            //   SHORT: entry - beBuffer → below entry → above current market when in profit
            //          (e.g. entry=29300, market=29268 after 32t, bePrice=29297.5 > 29268 ✓ valid BUY stop)
            //
            // IMPORTANT: using entry + beBuffer for SHORT places stop ABOVE entry
            //   which means we exit at a LOSS (−beBuffer ticks). That was the bug
            //   reverted by 1aba046 — the beSafe reasoning was wrong. When a SHORT trade
            //   is in profit (price < entry), entry − buffer IS above current price.
            //   NT8 accepts BUY stops above current market — the direction math holds.
            if (!beApplied && ticksIn >= beTicks)
            {
                double bePrice = isLong
                    ? entryPx + beBuffer * TickSize   // LONG: stop above entry (profit lock)
                    : entryPx - beBuffer * TickSize;  // SHORT: stop below entry (profit lock)
                // beSafe: stop must be safely on the profitable side of the current bar extreme.
                // LONG:  bePrice (above entry) must be below High − 1 tick (stop below current price)
                // SHORT: bePrice (below entry) must be above Low  + 1 tick (stop above current price)
                // When BE trigger fires (ticksIn >= beTicks), barExtreme is already beTicks away
                //   from entry, so bePrice (±beBuffer from entry, much less than beTicks)
                //   is always safely between entry and barExtreme — beSafe is nearly always true.
                bool   beSafe  = isLong ? (bePrice < barExtreme - TickSize)
                                        : (bePrice > barExtreme + TickSize);
                if (beSafe)
                {
                    try
                    {
                        // TAGGED SetStopLoss — MUST use same tag as EnterLong/EnterShort ("V6_LONG"/"V6_SHORT").
                        // NT8 tagless SetStopLoss does NOT update a stop that was created with a signal tag —
                        // the original SL stays at entry-time price and BE never fires on the chart.
                        SetStopLoss(tag, CalculationMode.Price, bePrice, false);
                        _cachedSlPrice = bePrice;
                        beApplied      = true;
                        Print(string.Format(CultureInfo.InvariantCulture,
                            "V6 BE: SL@{0:F2} (entry{1:+0;-0}t)  profit={2:F0}t  trigger={3}t  ({4})",
                            bePrice, beBuffer, ticksIn, beTicks, isEs ? "ES 8t" : "NQ 32t"));
                    }
                    catch (Exception ex) { Print("V6 BE: failed -- " + ex.Message); }
                }
            }

            // ── Stage 2 — Tight trail (activates at PL trigger, advances every bar, requires UseTrailStop) ──
            if (UseTrailStop)
            {
                if (!plApplied && ticksIn >= plTicks)
                {
                    double plStop = isLong
                        ? _bestPriceSeen - trailTicks * TickSize
                        : _bestPriceSeen + trailTicks * TickSize;
                    plStop = Math.Round(plStop / TickSize, MidpointRounding.AwayFromZero) * TickSize;
                    bool safe = isLong ? (plStop < Close[0]) : (plStop > Close[0]);
                    if (safe)
                    {
                        try
                        {
                            SetStopLoss(tag, CalculationMode.Price, plStop, false);  // tagged — matches entry tag
                            _cachedSlPrice = plStop;
                            plApplied      = true;
                            beApplied      = true;   // ensure BE flag set if PL fires first
                            Print(string.Format(CultureInfo.InvariantCulture,
                                "V6 Trail: SL@{0:F2}  step={1}t  profit={2:F0}t  trigger={3}t  ({4})",
                                plStop, trailTicks, ticksIn, plTicks, isEs ? "ES 4t" : "NQ 30t"));
                        }
                        catch (Exception ex) { Print("V6 Trail: failed -- " + ex.Message); }
                    }
                }
                else if (plApplied && mp != MarketPosition.Flat)
                {
                    // Advance trail each bar — tracks best price seen
                    double newStop = isLong
                        ? _bestPriceSeen - trailTicks * TickSize
                        : _bestPriceSeen + trailTicks * TickSize;
                    newStop = Math.Round(newStop / TickSize, MidpointRounding.AwayFromZero) * TickSize;
                    bool improved = isLong ? (newStop > _cachedSlPrice) : (newStop < _cachedSlPrice);
                    bool safe     = isLong ? (newStop < Close[0])       : (newStop > Close[0]);
                    if (improved && safe && _cachedSlPrice > 0)
                    {
                        try { SetStopLoss(tag, CalculationMode.Price, newStop, false); _cachedSlPrice = newStop; }  // tagged
                        catch { }
                    }
                }
            }
        }

        // ═══════════════════════════════════════════════════════════════════
        // ORDER SUBMISSION
        // ═══════════════════════════════════════════════════════════════════
        private void SubmitOrder(bool isLong)
        {
            // Hard guard — belt-and-suspenders beyond the OnBarUpdate gate.
            // If position is somehow not flat (race condition, re-entrant call),
            // abort immediately and reset _positionOpen so the next bar can retry.
            if (Position.MarketPosition != MarketPosition.Flat) { _positionOpen = false; return; }
            // Lock from this moment until OnExecutionUpdate confirms position is flat again.
            // Prevents a concurrent signal (new timestamp, new sigKey) from entering
            // SubmitOrder and overwriting SetStopLoss/SetProfitTarget on the live bracket.
            _positionOpen   = true;
            beApplied       = false;
            plApplied       = false;
            _bestPriceSeen  = 0;
            _cachedSlPrice  = 0;   // fix: reset so trail advance doesn't compare against previous trade's SL

            // Dynamic TP/SL mode
            if (UseDynamicTpSl && sigTpPoints > 0.0 && sigSlPoints > 0.0)
            {
                int slTicks = Math.Max(4,           (int)Math.Round(sigSlPoints / TickSize));
                int tpTicks = Math.Max(slTicks + 4, (int)Math.Round(sigTpPoints / TickSize));
                string tag  = isLong ? "V6_LONG" : "V6_SHORT";
                _tpTicks    = tpTicks;
                _slTicks    = slTicks;
                _linesDrawn = false;

                // Safety guard: the stop is placed AFTER the entry fills, relative to the
                // fill price. Verify the SL distance (slTicks) is large enough to clear
                // the current market by at least 1 tick — prevents "stop below/above market"
                // if price gaps against us between signal write and order submission.
                // We use Close[0] as a proxy for the expected fill; if even from Close the
                // stop would already be on the wrong side, skip the trade entirely.
                double expStopFromClose = isLong
                    ? Close[0] - slTicks * TickSize   // LONG: stop below close
                    : Close[0] + slTicks * TickSize;  // SHORT: stop above close
                bool stopSafe = isLong ? (expStopFromClose < Close[0]) : (expStopFromClose > Close[0]);
                // stopSafe is always true for valid slTicks — this is a sanity check only.
                // If slTicks somehow rounds to 0 or the math overflows, block the order.
                if (!stopSafe || slTicks <= 0)
                {
                    Print(string.Format(CultureInfo.InvariantCulture,
                        "V6: ORDER BLOCKED — calculated stop {0:F2} is invalid for {1} at {2:F2}  sl={3}t",
                        expStopFromClose, isLong ? "LONG" : "SHORT", Close[0], slTicks));
                    return;
                }

                // ── COMPREHENSIVE FIX 2026-05-17 ────────────────────────────────────
                // SetTrailStop(Ticks) AND SetStopLoss(Ticks) BOTH place the initial
                // stop N*tick BELOW Close[0] regardless of trade direction.
                // For a SHORT entry this puts the BuyToCover stop BELOW market →
                // NT8 rejects the order → "strategy terminated itself" → disable loop.
                // ROOT CAUSE: NT8 does not know the direction until the entry fills,
                // so it defaults to LONG arithmetic (close - N*tick) for both modes.
                //
                // FIX: always use CalculationMode.Price with an explicit directional
                // formula anchored to Close[0].  UseTrailStop trailing is now handled
                // entirely by the ManageExits stage 1 (BE) / stage 2 (PL tight trail).
                // ─────────────────────────────────────────────────────────────────────
                double slPx = isLong
                    ? Close[0] - slTicks * TickSize   // LONG:  SL below close
                    : Close[0] + slTicks * TickSize;  // SHORT: SL above close
                slPx = Math.Round(slPx / TickSize, MidpointRounding.AwayFromZero) * TickSize;
                // Safety guard: protect against extreme gap or rounding edge-case
                if ((isLong && slPx >= Close[0]) || (!isLong && slPx <= Close[0]))
                {
                    Print(string.Format(CultureInfo.InvariantCulture,
                        "V6: SL guard — slPx={0:F2} wrong side for {1} close={2:F2}, forcing 5t",
                        slPx, isLong ? "LONG" : "SHORT", Close[0]));
                    slPx = isLong ? Close[0] - 5 * TickSize : Close[0] + 5 * TickSize;
                }
                SetStopLoss(tag, CalculationMode.Price, slPx, false);
                _entrySlPoints = sigSlPoints;   // capture SL distance for trail logic
                string instrRoot = Instrument.MasterInstrument.Name.ToUpperInvariant();
                bool   isEsInst  = instrRoot == "ES" || instrRoot == "MES";
                int    pBe    = isEsInst ? (_exitCfgEsBeTicks    > 0 ? _exitCfgEsBeTicks    : (EsBeTicks    > 0 ? EsBeTicks    : 8))
                                         : (_exitCfgBeTicks      > 0 ? _exitCfgBeTicks      : (NqBeTicks    > 0 ? NqBeTicks    : 32));
                int    pPl    = isEsInst ? (_exitCfgEsPlTicks    > 0 ? _exitCfgEsPlTicks    : (EsPlTicks    > 0 ? EsPlTicks    : 12))
                                         : (_exitCfgPlTicks      > 0 ? _exitCfgPlTicks      : (NqPlTicks    > 0 ? NqPlTicks    : 36));
                int    pTrail = isEsInst ? (_exitCfgEsTrailTicks > 0 ? _exitCfgEsTrailTicks : (EsTrailTicks > 0 ? EsTrailTicks : 4))
                                         : (_exitCfgTrailTicks   > 0 ? _exitCfgTrailTicks   : (NqTrailTicks > 0 ? NqTrailTicks : 30));
                Print(string.Format(CultureInfo.InvariantCulture,
                    "V6: DynOrder {0}  SL={1:F2} ({2}t)  TP={3}t  Trail={4}  ({5}: BE={6}t  PL={7}t  Step={8}t)",
                    isLong ? "LONG" : "SHORT", slPx, slTicks, tpTicks,
                    UseTrailStop ? "ON" : "OFF",
                    isEsInst ? "ES" : "NQ",
                    pBe, pPl, pTrail));
                SetProfitTarget(tag, CalculationMode.Ticks, tpTicks);
                if (isLong) EnterLong (ContractSize, tag);
                else        EnterShort(ContractSize, tag);
                return;
            }

            // ATM template fallback
            string template = AtmStrategyName;
            if (string.IsNullOrWhiteSpace(template))
            {
                Print("V6: ATM template name is empty — set property 'ATM Strategy Name'");
                return;
            }
            atmInFlight   = true;
            atmStrategyId = Guid.NewGuid().ToString("N");
            atmOrderId    = Guid.NewGuid().ToString("N");
            AtmStrategyCreate(
                isLong ? OrderAction.Buy : OrderAction.SellShort,
                OrderType.Market, 0, 0, TimeInForce.Day,
                atmOrderId, template, atmStrategyId,
                (ErrorCode errCode, string cbId) =>
                {
                    atmInFlight = false;
                    if (errCode != ErrorCode.NoError)
                        Print("V6: ATM error: " + errCode);
                });
            Print("V6: ATM submitted — " + template
                  + "  id=" + atmStrategyId.Substring(0, 8) + "...");
        }

        // ═══════════════════════════════════════════════════════════════════
        // EXECUTION UPDATE
        // Authoritative clear for _positionOpen: fires on every fill.
        // When the resulting position is flat, it is safe to accept the next
        // entry signal — unlock the guard set in SubmitOrder.
        // Using OnExecutionUpdate (not ManageExits) so the clear happens the
        // instant NT8 confirms the exit fill, not one tick later.
        // ═══════════════════════════════════════════════════════════════════
        protected override void OnExecutionUpdate(Cbi.Execution execution, string executionId,
            double price, int quantity, Cbi.MarketPosition marketPosition,
            string orderId, DateTime time)
        {
            // Use Position.MarketPosition (the account state PROPERTY) — NOT the
            // marketPosition PARAMETER which is the execution direction (Long=buy, Short=sell).
            // When a SHORT exits via TP, NT8 passes MarketPosition.Long here (buy-to-cover),
            // so checking the parameter would NEVER see Flat and _positionOpen stays true forever.
            if (Position.MarketPosition == MarketPosition.Flat)
                _positionOpen = false;
        }

        // ═══════════════════════════════════════════════════════════════════
        // SIGNAL FILE READER
        // ═══════════════════════════════════════════════════════════════════
        private void ReadSignalFile()
        {
            try
            {
                if (string.IsNullOrWhiteSpace(SignalFilePath) || !File.Exists(SignalFilePath)) return;
                DateTime fileTime = File.GetLastWriteTimeUtc(SignalFilePath);
                if (fileTime <= lastFileWrite) return;
                lastFileWrite = fileTime;

                string json = File.ReadAllText(SignalFilePath);
                if (string.IsNullOrWhiteSpace(json)) return;

                // Staleness check via heartbeat
                string hb = ExtractString(json, "heartbeat");
                if (!string.IsNullOrWhiteSpace(hb))
                {
                    DateTime hbDt;
                    if (DateTime.TryParse(hb, CultureInfo.InvariantCulture,
                        DateTimeStyles.AdjustToUniversal | DateTimeStyles.AssumeUniversal, out hbDt))
                    {
                        if ((DateTime.UtcNow - hbDt.ToUniversalTime()).TotalSeconds > MaxStaleSecs)
                        {
                            sigAction  = "FLAT";
                            sigWarmup  = true;
                            return;
                        }
                    }
                }

                sigAction      = (ExtractString(json, "action") ?? "FLAT").ToUpperInvariant().Trim();
                sigLongProb    = ExtractDouble(json, "long_prob");
                sigShortProb   = ExtractDouble(json, "short_prob");
                sigTpPoints    = ExtractDouble(json, "tp_points");
                sigSlPoints    = ExtractDouble(json, "sl_points");
                sigAtr         = ExtractDouble(json, "atr");
                sigClose       = ExtractDouble(json, "close");
                sigRegime      = ExtractString(json, "regime") ?? "";
                sigWarmup      = ExtractBool(json, "warmup");
                sigNewsBlocked = ExtractBool(json, "news_blocked");
                sigNewsReason  = ExtractString(json, "news_reason") ?? "";
                sigTimestamp   = ExtractString(json, "timestamp") ?? "";
                sigTier        = (int)ExtractDouble(json, "tier");   // 0 if absent (old feed)
                sigThLong      = ExtractDouble(json, "th_long");      // 0.0 if absent
                sigThShort     = ExtractDouble(json, "th_short");     // 0.0 if absent
                sigTrend       = ExtractString(json, "trend") ?? "";  // UP/DOWN/NEUTRAL/"" if absent

                // last_trade nested block — gate label for panel display
                string ltBlock = ExtractBlock(json, "last_trade");
                if (ltBlock != null)
                {
                    sigLastTradeLabel  = ExtractString(ltBlock, "label_nt8") ?? "";
                    sigLastTradeAction = (ExtractString(ltBlock, "action") ?? "").ToUpperInvariant().Trim();
                }
                else
                {
                    sigLastTradeLabel  = "";
                    sigLastTradeAction = "";
                }
            }
            catch (Exception ex)
            {
                Print("V6: Signal read error: " + ex.Message);
            }
        }

        // ═══════════════════════════════════════════════════════════════════
        // P&L FILE — per-symbol, derived from SignalFilePath
        // v6_nq_signal.json → v6_nq_pnl.json
        // v6_es_signal.json → v6_es_pnl.json
        // Each chart instance writes its own file → web dashboard shows
        // per-card P&L for each instrument/account independently.
        // ═══════════════════════════════════════════════════════════════════
        private string   _pnlPath     = null;
        private DateTime _lastPnlWrite = DateTime.MinValue;

        // ─── Position file — for V6_PositionDisplay indicator on other charts ────
        private string   _posPath       = null;
        private DateTime _lastPosWrite  = DateTime.MinValue;
        private double   _cachedSlPrice = 0;
        private double   _cachedTpPrice = 0;

        // ─── Trail tracking ──────────────────────────────────────────────────
        private double _bestPriceSeen = 0;  // highest High seen (LONG) / lowest Low (SHORT)

        // ─── Eval / Prop firm ────────────────────────────────────────────────
        private bool     _evalOn           = false;
        private double   _evalPTarget      = 500.0;
        private double   _evalLLimit       = 1000.0;
        private bool     _evalDrawdown     = false;
        private bool     _evalBlocked      = false;  // loss limit hit — block new entries
        private bool     _evalProfitLocked = false;  // profit target hit (drawdown mode) — block new entries
        private DateTime _lastEvalRead     = DateTime.MinValue;

        // ─── Exit config (live BE/trail overrides from dashboard) ────────────
        private int      _exitCfgBeTicks    = 0;  // NQ — 0 = not loaded / use fallback
        private int      _exitCfgPlTicks    = 0;
        private int      _exitCfgTrailTicks = 0;
        private int      _exitCfgEsBeTicks    = 0;  // ES — 0 = not loaded / use fallback
        private int      _exitCfgEsPlTicks    = 0;
        private int      _exitCfgEsTrailTicks = 0;
        private DateTime _lastExitCfgRead   = DateTime.MinValue;

        private string GetPnlPath()
        {
            if (_pnlPath != null) return _pnlPath;
            // Derive PnL path from signal path: *_signal.json → *_pnl.json
            try
            {
                _pnlPath = SignalFilePath.Replace("_signal.json", "_pnl.json");
            }
            catch
            {
                _pnlPath = @"D:\Claud Folder\V6\ml_signals\v6_pnl.json"; // fallback
            }
            return _pnlPath;
        }

        private void WritePnlFile()
        {
            try
            {
                string pnlPath    = GetPnlPath();
                double realized   = Account.Get(AccountItem.RealizedProfitLoss,   Currency.UsDollar);
                double unrealized = Account.Get(AccountItem.UnrealizedProfitLoss, Currency.UsDollar);
                double cash       = Account.Get(AccountItem.CashValue,            Currency.UsDollar);
                double netliq     = Account.Get(AccountItem.NetLiquidation,       Currency.UsDollar);
                string pos        = Position.MarketPosition == MarketPosition.Long  ? "LONG"
                                  : Position.MarketPosition == MarketPosition.Short ? "SHORT" : "FLAT";

                string json = string.Format(CultureInfo.InvariantCulture,
                    "{{\"timestamp\":\"{0}\",\"account\":\"{1}\"," +
                    "\"realized\":{2:F2},\"unrealized\":{3:F2},\"total\":{4:F2}," +
                    "\"cashValue\":{5:F2},\"netLiquidation\":{6:F2}," +
                    "\"trades\":{7},\"position\":\"{8}\"}}",
                    DateTime.UtcNow.ToString("o"), Account.Name,
                    realized, unrealized, realized + unrealized,
                    cash, netliq, todayTrades, pos);

                string tmp = pnlPath + ".tmp";
                File.WriteAllText(tmp, json);
                if (File.Exists(pnlPath)) File.Delete(pnlPath);
                File.Move(tmp, pnlPath);
            }
            catch { }
        }

        // ═══════════════════════════════════════════════════════════════════
        // POSITION FILE — for V6_PositionDisplay indicator on other charts
        // v6_nq_signal.json → v6_nq_position.json  (per-symbol, same folder)
        // Written every 5 s; display indicator reads this to draw lines.
        // ═══════════════════════════════════════════════════════════════════
        private string GetPositionPath()
        {
            if (_posPath != null) return _posPath;
            try { _posPath = SignalFilePath.Replace("_signal.json", "_position.json"); }
            catch { _posPath = @"D:\Claud Folder\V6\ml_signals\v6_nq_position.json"; }
            return _posPath;
        }

        /// <summary>
        /// Scans Account.Orders for the working stop order placed by this strategy
        /// and returns its current stop price (which tracks the trail).
        /// Returns 0 if not found — caller falls back to _cachedSlPrice.
        /// </summary>
        private double ScanStopOrderPrice()
        {
            if (Position.MarketPosition == MarketPosition.Flat) return 0;
            bool   isLong = Position.MarketPosition == MarketPosition.Long;
            string tag    = isLong ? "V6_LONG" : "V6_SHORT";
            try
            {
                foreach (var o in Account.Orders)
                {
                    if (o.OrderState == OrderState.Working &&
                        (o.OrderType == OrderType.StopMarket ||
                         o.OrderType == OrderType.StopLimit) &&
                        o.Name == tag)
                        return o.StopPrice;
                }
            }
            catch { }
            return 0;
        }

        private void WritePositionFile()
        {
            try
            {
                var    mp    = Position.MarketPosition;
                string dir   = mp == MarketPosition.Long  ? "LONG"
                             : mp == MarketPosition.Short ? "SHORT" : "FLAT";
                string stage = plApplied ? "PL" : beApplied ? "BE" : "OPEN";
                double entry = mp != MarketPosition.Flat ? Position.AveragePrice : 0;
                double sl    = 0;
                double tp    = 0;
                double pnl   = 0;

                if (mp != MarketPosition.Flat)
                {
                    double found = ScanStopOrderPrice();
                    if (found > 0) { _cachedSlPrice = found; sl = found; }
                    else             sl = _cachedSlPrice;

                    if (_tpTicks > 0)
                    {
                        tp = mp == MarketPosition.Long
                           ? entry + _tpTicks * TickSize
                           : entry - _tpTicks * TickSize;
                        _cachedTpPrice = tp;
                    }
                    else tp = _cachedTpPrice;

                    double ptVal = Instrument.MasterInstrument.PointValue;
                    pnl = mp == MarketPosition.Long
                        ? (Close[0] - entry) * Position.Quantity * ptVal
                        : (entry - Close[0]) * Position.Quantity * ptVal;
                }
                else { _cachedSlPrice = 0; _cachedTpPrice = 0; }

                string posPath = GetPositionPath();
                string json = string.Format(CultureInfo.InvariantCulture,
                    "{{\"timestamp\":\"{0}\",\"direction\":\"{1}\"," +
                    "\"entry\":{2:F2},\"tp\":{3:F2},\"sl\":{4:F2}," +
                    "\"unrealized\":{5:F2},\"exit_stage\":\"{6}\"}}",
                    DateTime.UtcNow.ToString("o"), dir,
                    entry, tp, sl, pnl, stage);

                string tmp = posPath + ".tmp";
                File.WriteAllText(tmp, json);
                if (File.Exists(posPath)) File.Delete(posPath);
                File.Move(tmp, posPath);
            }
            catch { }
        }

        // ═══════════════════════════════════════════════════════════════════
        // EVAL CONFIG READER
        // Reads v6_eval_config.json at most every 30 s.
        // On missing file → silently leaves _evalOn=false (fail-open for trading).
        // ═══════════════════════════════════════════════════════════════════
        private void ReadEvalConfig()
        {
            if ((DateTime.UtcNow - _lastEvalRead).TotalSeconds < 30) return;
            _lastEvalRead = DateTime.UtcNow;
            try
            {
                if (string.IsNullOrWhiteSpace(EvalConfigPath) || !File.Exists(EvalConfigPath)) return;
                string json = File.ReadAllText(EvalConfigPath);
                if (string.IsNullOrWhiteSpace(json)) return;

                _evalOn       = ExtractBool  (json, "eval_on");
                _evalPTarget  = ExtractDouble(json, "eval_p");
                _evalLLimit   = ExtractDouble(json, "eval_l");
                _evalDrawdown = ExtractBool  (json, "drawdown_mode");

                // Clamp to safe minimums so we never divide by zero or block on a 0 limit
                if (_evalPTarget <= 0) _evalPTarget = 500.0;
                if (_evalLLimit  <= 0) _evalLLimit  = 1000.0;
            }
            catch (Exception ex) { Print("V6: EvalConfig read error: " + ex.Message); }
        }

        // ═══════════════════════════════════════════════════════════════════
        // EXIT CONFIG READER
        // Reads v6_exit_config.json at most every 30 s.
        // Provides live NQ BE/trail tick overrides written by the web dashboard.
        // Missing file or 0 value → falls back to NqBeTicks/NqPlTicks/NqTrailTicks
        //   properties, then to coded defaults (32/36/30t).
        // ═══════════════════════════════════════════════════════════════════
        private void ReadExitConfig()
        {
            if ((DateTime.UtcNow - _lastExitCfgRead).TotalSeconds < 30) return;
            _lastExitCfgRead = DateTime.UtcNow;
            try
            {
                if (string.IsNullOrWhiteSpace(ExitConfigPath) || !File.Exists(ExitConfigPath)) return;
                string json = File.ReadAllText(ExitConfigPath);
                if (string.IsNullOrWhiteSpace(json)) return;
                int be    = (int)ExtractDouble(json, "nq_be_ticks");
                int pl    = (int)ExtractDouble(json, "nq_pl_ticks");
                int trail = (int)ExtractDouble(json, "nq_trail_ticks");
                int esbe    = (int)ExtractDouble(json, "es_be_ticks");
                int espl    = (int)ExtractDouble(json, "es_pl_ticks");
                int estrail = (int)ExtractDouble(json, "es_trail_ticks");
                // Only update if value is non-negative — 0 means "use fallback"
                if (be      >= 0) _exitCfgBeTicks      = be;
                if (pl      >= 0) _exitCfgPlTicks      = pl;
                if (trail   >= 0) _exitCfgTrailTicks   = trail;
                if (esbe    >= 0) _exitCfgEsBeTicks    = esbe;
                if (espl    >= 0) _exitCfgEsPlTicks    = espl;
                if (estrail >= 0) _exitCfgEsTrailTicks = estrail;
            }
            catch (Exception ex) { Print("V6: ExitConfig read error: " + ex.Message); }
        }

        // ═══════════════════════════════════════════════════════════════════
        // STATUS PANEL — top-left, large font, draggable
        // Robust canvas finder: walks visual tree so it works on any NT8
        // chart layout (Parent is not always a Canvas directly).
        // ═══════════════════════════════════════════════════════════════════
        private Canvas FindOverlayCanvas()
        {
            // Walk up to 25 levels looking for any Panel ancestor (Grid, DockPanel, Canvas…).
            // NT8 chart hierarchy often has ContentPresenter between ChartControl and its
            // parent Panel, so checking only ChartControl.Parent as Panel fails silently.
            // We accept the first Panel of ANY type and inject our own Canvas into it.
            System.Windows.DependencyObject node = ChartControl;
            for (int i = 0; i < 25; i++)
            {
                node = System.Windows.Media.VisualTreeHelper.GetParent(node);
                if (node == null) break;

                // If we find a Canvas directly, add panelBorder to it as-is
                var existingCanvas = node as Canvas;
                if (existingCanvas != null) return existingCanvas;

                // Any other Panel (Grid, DockPanel, StackPanel, etc.) — inject our Canvas
                var panel = node as Panel;
                if (panel != null)
                {
                    var injected = new Canvas
                    {
                        // IsHitTestVisible = true so panelBorder children receive mouse events (drag works).
                        // Background = null means the Canvas background itself has no hit area,
                        // so clicks on empty chart areas pass through to NT8 naturally.
                        IsHitTestVisible    = true,
                        HorizontalAlignment = HorizontalAlignment.Stretch,
                        VerticalAlignment   = VerticalAlignment.Stretch,
                        Background          = null,
                    };
                    System.Windows.Controls.Panel.SetZIndex(injected, 9999);
                    panel.Children.Add(injected);
                    return injected;
                }
            }
            return null;   // visual tree exhausted — panel will not appear
        }

        private void UpdatePanel()
        {
            if (ChartControl == null) return;
            try
            {
                ChartControl.Dispatcher.InvokeAsync(() =>
                {
                    // ── First-time panel creation ────────────────────────────
                    if (panelBorder == null)
                    {
                        var overlay = FindOverlayCanvas();
                        if (overlay == null) return;
                        _overlayCanvas = overlay;

                        // ── Label stack ──────────────────────────────────────
                        // Row 0: title bar
                        _titleBlock = new TextBlock
                        {
                            Text       = "  ⚡ V6 UNIVERSAL BOT",
                            FontFamily = new FontFamily("Segoe UI"),
                            FontSize   = 16,
                            FontWeight = FontWeights.Bold,
                            Foreground = new SolidColorBrush(Color.FromRgb(255, 255, 255)),
                            Background = new SolidColorBrush(Color.FromArgb(140, 20, 25, 55)), // semi-transparent header
                            Padding    = new Thickness(8, 6, 8, 6),
                        };

                        // Row 1+: data lines — bold white so text pops against chart
                        panelText = new TextBlock
                        {
                            Background  = Brushes.Transparent,
                            FontFamily  = new FontFamily("Consolas"),
                            FontSize    = 15,
                            FontWeight  = FontWeights.SemiBold,
                            Foreground  = Brushes.White,
                            Padding     = new Thickness(12, 8, 18, 10),
                            LineHeight  = 27,
                        };

                        var stack = new StackPanel { Orientation = Orientation.Vertical };
                        stack.Children.Add(_titleBlock);
                        stack.Children.Add(panelText);

                        panelBorder = new Border
                        {
                            // Alpha=130 ≈ 51% opaque — chart candles visible behind it
                            Background      = new SolidColorBrush(Color.FromArgb(130, 5, 8, 28)),
                            BorderBrush     = new SolidColorBrush(Color.FromRgb(55, 65, 95)), // overridden each tick
                            BorderThickness = new Thickness(2),
                            CornerRadius    = new CornerRadius(8),
                            Child           = stack,
                            Cursor          = System.Windows.Input.Cursors.SizeAll,
                            MinWidth        = 400,
                            Effect          = new System.Windows.Media.Effects.DropShadowEffect
                            {
                                Color      = Colors.Black,
                                BlurRadius = 18,
                                ShadowDepth = 4,
                                Opacity    = 0.85,
                            },
                        };

                        // ── Drag support ─────────────────────────────────────
                        panelBorder.MouseLeftButtonDown += (s, e) =>
                        {
                            _isDragging  = true;
                            var p        = e.GetPosition(_overlayCanvas);
                            _dragOffsetX = p.X - Canvas.GetLeft(panelBorder);
                            _dragOffsetY = p.Y - Canvas.GetTop(panelBorder);
                            panelBorder.CaptureMouse();
                            e.Handled = true;
                        };
                        panelBorder.MouseMove += (s, e) =>
                        {
                            if (!_isDragging) return;
                            var p = e.GetPosition(_overlayCanvas);
                            Canvas.SetLeft(panelBorder, p.X - _dragOffsetX);
                            Canvas.SetTop (panelBorder, p.Y - _dragOffsetY);
                            e.Handled = true;
                        };
                        panelBorder.MouseLeftButtonUp += (s, e) =>
                        {
                            _isDragging = false;
                            panelBorder.ReleaseMouseCapture();
                            e.Handled = true;
                        };

                        overlay.Children.Add(panelBorder);
                        Canvas.SetLeft(panelBorder, 12.0);
                        Canvas.SetTop (panelBorder, 12.0);
                        System.Windows.Controls.Panel.SetZIndex(panelBorder, 9999);
                    }

                    // ── Build panel content (per-field colours) ──────────────
                    var mp      = Position.MarketPosition;
                    bool isLong  = mp == MarketPosition.Long;
                    bool isShort = mp == MarketPosition.Short;
                    bool isFlat  = mp == MarketPosition.Flat;

                    // ── Palette ───────────────────────────────────────────────
                    Brush cLabel  = new SolidColorBrush(Color.FromRgb(230, 232, 238)); // bright white labels — easy to read
                    Brush cSep    = new SolidColorBrush(Color.FromRgb( 80,  90, 130)); // separator line
                    Brush cWhite  = new SolidColorBrush(Color.FromRgb(255, 255, 255)); // pure white values
                    Brush cGray   = new SolidColorBrush(Color.FromRgb(155, 160, 175)); // muted gray
                    Brush cGreen  = new SolidColorBrush(Color.FromRgb(  0, 230, 118)); // bright green
                    Brush cRed    = new SolidColorBrush(Color.FromRgb(255,  82,  82)); // bright red
                    Brush cYellow = new SolidColorBrush(Color.FromRgb(255, 214,  10)); // amber/yellow
                    Brush cOrange = new SolidColorBrush(Color.FromRgb(255, 140,  40)); // orange

                    // ── Signal ────────────────────────────────────────────────
                    string actionStr;
                    Brush  actionBrush;
                    if      (sigWarmup)           { actionStr = "⏳  WARMING UP...";   actionBrush = cYellow; }
                    else if (sigNewsBlocked)       { actionStr = "⛔  NEWS BLOCK";      actionBrush = cOrange; }
                    else if (sigAction == "BUY")   { actionStr = "▲  BUY  ( LONG )";   actionBrush = cGreen;  }
                    else if (sigAction == "SELL")  { actionStr = "▼  SELL  ( SHORT )"; actionBrush = cRed;    }
                    else                           { actionStr = "■  FLAT";             actionBrush = cGray;   }

                    // ── Long / Short probability colours ──────────────────────
                    // Use live tier thresholds from signal JSON; fall back to T2
                    // defaults if feed hasn't emitted them yet (sigThLong == 0).
                    double effThLong  = sigThLong  > 0.01 ? sigThLong  : 0.50;
                    double effThShort = sigThShort > 0.01 ? sigThShort : 0.48;
                    bool  longFires  = sigLongProb  >= effThLong;
                    bool  shortFires = sigShortProb >= effThShort;
                    Brush longPBrush  = longFires  ? cGreen  : (sigLongProb  > 0.40 ? new SolidColorBrush(Color.FromRgb( 80,180,110)) : cGray);
                    Brush shortPBrush = shortFires ? cRed    : (sigShortProb > 0.40 ? new SolidColorBrush(Color.FromRgb(200,100,100)) : cGray);

                    // ── Regime colour ─────────────────────────────────────────
                    Brush regimeBrush;
                    switch (sigRegime)
                    {
                        case "TREND_UP":   regimeBrush = cGreen;  break;
                        case "TREND_DOWN": regimeBrush = cRed;    break;
                        case "HIGH_VOL":   regimeBrush = cOrange; break;
                        default:           regimeBrush = cYellow; break; // RANGE
                    }

                    // ── Position & live P&L ───────────────────────────────────
                    double realizedPnl = 0.0;
                    try { realizedPnl = Account.Get(AccountItem.RealizedProfitLoss, Currency.UsDollar); } catch { }

                    string posStr;
                    Brush  posBrush;
                    double floatPnl = 0.0;
                    if (isFlat)
                    {
                        posStr   = "FLAT";
                        posBrush = cGray;
                    }
                    else
                    {
                        double ptVal = Instrument.MasterInstrument.PointValue;  // $20 NQ, $50 ES, $10 CL, $100 GC
                        floatPnl = isLong
                            ? (Close[0] - Position.AveragePrice) * Position.Quantity * ptVal
                            : (Position.AveragePrice - Close[0]) * Position.Quantity * ptVal;
                        posStr  = string.Format(CultureInfo.InvariantCulture,
                            "{0}  @  {1:F2}", isLong ? "LONG" : "SHORT",
                            Position.AveragePrice);
                        posBrush = isLong ? cGreen : cRed;
                    }

                    // P&L row: live float when in trade, session realized when flat
                    string pnlStr;
                    Brush  pnlBrush;
                    if (isFlat)
                    {
                        pnlStr  = string.Format(CultureInfo.InvariantCulture,
                            "Session {0:+$#,##0.00;-$#,##0.00;$0.00}", realizedPnl);
                        pnlBrush = realizedPnl > 0 ? cGreen : realizedPnl < 0 ? cRed : cGray;
                    }
                    else
                    {
                        pnlStr  = string.Format(CultureInfo.InvariantCulture,
                            "{0:+$#,##0.00;-$#,##0.00}", floatPnl);
                        pnlBrush = floatPnl >= 0 ? cGreen : cRed;
                    }

                    // ── Dynamic panel border + title based on position ─────────
                    if (panelBorder != null)
                    {
                        panelBorder.BorderBrush = new SolidColorBrush(
                            isLong  ? Color.FromRgb(  0, 200,  80)   // green border
                          : isShort ? Color.FromRgb(220,  50,  50)   // red border
                          : Color.FromRgb( 55,  65,  95));            // neutral navy when flat
                    }
                    if (_titleBlock != null)
                    {
                        if (isLong)
                        {
                            _titleBlock.Background = new SolidColorBrush(Color.FromArgb(160,   0, 120,  50));
                            _titleBlock.Foreground = new SolidColorBrush(Color.FromRgb(140, 255, 160));
                        }
                        else if (isShort)
                        {
                            _titleBlock.Background = new SolidColorBrush(Color.FromArgb(160, 180,  25,  25));
                            _titleBlock.Foreground = new SolidColorBrush(Color.FromRgb(255, 160, 160));
                        }
                        else
                        {
                            _titleBlock.Background = new SolidColorBrush(Color.FromArgb(140,  20,  25,  55)); // matches panel header
                            _titleBlock.Foreground = new SolidColorBrush(Color.FromRgb(255, 255, 255));
                        }
                    }

                    // ── Exit stage ────────────────────────────────────────────
                    string exitStr;
                    Brush  exitBrush;
                    if      (isFlat)    { exitStr = "—";                       exitBrush = cGray;   }
                    else if (plApplied) { exitStr = "Stage 2 — Profit Lock ✓"; exitBrush = cGreen;  }
                    else if (beApplied) { exitStr = "Stage 1 — Break-Even  ✓"; exitBrush = cYellow; }
                    else                { exitStr = "Watching...";              exitBrush = cGray;   }

                    // ── BE / Trail countdown ─────────────────────────────────
                    // When in a position: shows how many ticks of profit remain
                    // before BE or Trail fires, or confirms ✓ with the current SL.
                    string beCountStr, trailCountStr;
                    Brush  beCountBrush, trailCountBrush;

                    if (isFlat || !UseDynamicTpSl)
                    {
                        beCountStr      = "—";
                        trailCountStr   = "—";
                        beCountBrush    = cGray;
                        trailCountBrush = cGray;
                    }
                    else
                    {
                        // 3-level fallback: exit_config JSON → NT8 property → coded default
                        string instrCD = Instrument.MasterInstrument.Name.ToUpperInvariant();
                        bool   isEsCD  = instrCD == "ES" || instrCD == "MES";
                        int cdBe = isEsCD
                            ? (_exitCfgEsBeTicks > 0 ? _exitCfgEsBeTicks : (EsBeTicks > 0 ? EsBeTicks :  8))
                            : (_exitCfgBeTicks   > 0 ? _exitCfgBeTicks   : (NqBeTicks > 0 ? NqBeTicks : 32));
                        int cdPl = isEsCD
                            ? (_exitCfgEsPlTicks > 0 ? _exitCfgEsPlTicks : (EsPlTicks > 0 ? EsPlTicks : 12))
                            : (_exitCfgPlTicks   > 0 ? _exitCfgPlTicks   : (NqPlTicks > 0 ? NqPlTicks : 36));

                        double entryCD    = Position.AveragePrice;
                        double extremeCD  = isLong ? High[0] : Low[0];
                        double ticksInCD  = isLong
                            ? (extremeCD - entryCD) / TickSize
                            : (entryCD  - extremeCD) / TickSize;
                        double ptsInCD    = ticksInCD * TickSize;

                        // ── BE countdown / confirmed ──
                        if (beApplied)
                        {
                            beCountStr   = string.Format(CultureInfo.InvariantCulture,
                                "✓  SL @ {0:F2}", _cachedSlPrice);
                            beCountBrush = cGreen;
                        }
                        else
                        {
                            int toGo = (int)Math.Max(0, Math.Ceiling((double)cdBe - ticksInCD));
                            if (toGo == 0)
                            {
                                beCountStr   = "⚡ Triggering...";
                                beCountBrush = cYellow;
                            }
                            else
                            {
                                beCountStr = string.Format(CultureInfo.InvariantCulture,
                                    "{0}t ({1:F2} pts)  [ in: {2:F0}t / {3:F2} pts ]",
                                    toGo, toGo * TickSize, ticksInCD, ptsInCD);
                                beCountBrush = toGo <= 8 ? cYellow : cGray;
                            }
                        }

                        // ── Trail countdown / confirmed (requires UseTrailStop) ──
                        if (!UseTrailStop)
                        {
                            trailCountStr   = "OFF";
                            trailCountBrush = cGray;
                        }
                        else if (plApplied)
                        {
                            trailCountStr   = string.Format(CultureInfo.InvariantCulture,
                                "✓  Trailing  SL @ {0:F2}", _cachedSlPrice);
                            trailCountBrush = cGreen;
                        }
                        else
                        {
                            int toGo = (int)Math.Max(0, Math.Ceiling((double)cdPl - ticksInCD));
                            if (toGo == 0)
                            {
                                trailCountStr   = "⚡ Activating...";
                                trailCountBrush = cYellow;
                            }
                            else
                            {
                                trailCountStr = string.Format(CultureInfo.InvariantCulture,
                                    "{0}t ({1:F2} pts)  [ in: {2:F0}t / {3:F2} pts ]",
                                    toGo, toGo * TickSize, ticksInCD, ptsInCD);
                                trailCountBrush = toGo <= 8 ? cYellow : cGray;
                            }
                        }
                    }

                    // ── News ──────────────────────────────────────────────────
                    string newsStr  = sigNewsBlocked ? "⛔  BLOCKED — " + sigNewsReason : "✓  Clear";
                    Brush  newsBrush = sigNewsBlocked ? cRed : cGreen;

                    // ── Eval / Prop firm status ───────────────────────────────
                    string evalStr;
                    Brush  evalBrush;
                    if (!_evalOn)
                    { evalStr = "OFF"; evalBrush = cGray; }
                    else if (_evalBlocked)
                    { evalStr = string.Format(CultureInfo.InvariantCulture,
                        "⛔  LOSS LIMIT  L${0:F0}", _evalLLimit);
                      evalBrush = cRed; }
                    else if (_evalProfitLocked)
                    { evalStr = string.Format(CultureInfo.InvariantCulture,
                        "⏸  PROFIT LOCKED  P${0:F0}", _evalPTarget);
                      evalBrush = cYellow; }
                    else
                    { evalStr = string.Format(CultureInfo.InvariantCulture,
                        "✓  Active   L${0:F0}  P${1:F0}{2}",
                        _evalLLimit, _evalPTarget, _evalDrawdown ? "  [DW]" : "");
                      evalBrush = cGreen; }

                    // ── Probability bars ──────────────────────────────────────
                    string lBar = BuildBar(sigLongProb,  effThLong);
                    string sBar = BuildBar(sigShortProb, effThShort);

                    // ── Rebuild Inlines (per-field colour) ────────────────────
                    panelText.Inlines.Clear();

                    // local helpers
                    Action<string, Brush> A  = (t, b) =>
                        panelText.Inlines.Add(
                            new System.Windows.Documents.Run(t) { Foreground = b });
                    Action NL = () =>
                        panelText.Inlines.Add(new System.Windows.Documents.LineBreak());
                    Action SEP = () =>
                    {
                        panelText.Inlines.Add(
                            new System.Windows.Documents.Run(
                                " ─────────────────────────────────────\n")
                            { Foreground = cSep });
                    };

                    // Row: Signal
                    A(" Signal   : ", cLabel); A(actionStr, actionBrush); NL();
                    SEP();

                    // Rows: Probabilities
                    A(" Long  P  : ", cLabel);
                    A(string.Format(CultureInfo.InvariantCulture, "{0:F3}", sigLongProb), longPBrush);
                    A("  " + lBar, longFires ? cGreen : cGray); NL();

                    A(" Short P  : ", cLabel);
                    A(string.Format(CultureInfo.InvariantCulture, "{0:F3}", sigShortProb), shortPBrush);
                    A("  " + sBar, shortFires ? cRed : cGray); NL();

                    // Tier / threshold row — shows active tier and its L/S gate values
                    string tierStr = sigTier > 0
                        ? string.Format(CultureInfo.InvariantCulture,
                            "T{0}  L≥{1:F2}  S≥{2:F2}", sigTier, effThLong, effThShort)
                        : string.Format(CultureInfo.InvariantCulture,
                            "—   L≥{0:F2}  S≥{1:F2}", effThLong, effThShort);
                    Brush tierBrush = sigTier == 1 ? cGreen : sigTier == 2 ? cYellow : sigTier == 3 ? cOrange : cGray;
                    A(" Tier/Thr : ", cLabel); A(tierStr, tierBrush); NL();

                    A(" Regime   : ", cLabel);
                    A(string.IsNullOrEmpty(sigRegime) ? "—" : sigRegime, regimeBrush); NL();

                    // Trend row — EMA gate direction (the actual BUY/SELL authority)
                    Brush trendBrush;
                    string trendStr;
                    switch (sigTrend)
                    {
                        case "UP":      trendBrush = cGreen;  trendStr = "▲  UP";      break;
                        case "DOWN":    trendBrush = cRed;    trendStr = "▼  DOWN";    break;
                        case "NEUTRAL": trendBrush = cGray;   trendStr = "—  NEUTRAL"; break;
                        default:        trendBrush = cGray;   trendStr = "—";          break;
                    }
                    A(" Trend    : ", cLabel); A(trendStr, trendBrush); NL();

                    // Gate row — last trade gate / tier / trend (persists across FLAT bars)
                    if (!string.IsNullOrEmpty(sigLastTradeLabel))
                    {
                        Brush gateBrush = sigLastTradeAction == "BUY"  ? cGreen :
                                          sigLastTradeAction == "SELL" ? cRed   : cGray;
                        A(" Gate     : ", cLabel); A(sigLastTradeLabel, gateBrush); NL();
                    }
                    SEP();

                    // Rows: Trade state
                    A(" Position : ", cLabel); A(posStr,       posBrush);       NL();
                    A(" P & L    : ", cLabel); A(pnlStr,       pnlBrush);       NL();
                    A(" Exit     : ", cLabel); A(exitStr,      exitBrush);      NL();
                    A(" BE in    : ", cLabel); A(beCountStr,   beCountBrush);   NL();
                    A(" Trail in : ", cLabel); A(trailCountStr,trailCountBrush);NL();
                    A(" News     : ", cLabel); A(newsStr,      newsBrush);      NL();
                    A(" Eval     : ", cLabel); A(evalStr,   evalBrush);   NL();
                    SEP();

                    // Row: Stats
                    A(" ATR      : ", cLabel);
                    A(string.Format(CultureInfo.InvariantCulture, "{0:F1}", sigAtr), cWhite);
                    A("      Trades: ", cLabel);
                    A(todayTrades.ToString(), todayTrades > 0 ? cYellow : cWhite); NL();
                    A(" File     : ", cLabel);
                    A(System.IO.Path.GetFileName(SignalFilePath), cGray);

                    panelText.Foreground = cWhite; // default fallback
                });
            }
            catch { }
        }

        /// <summary>Mini ASCII probability bar, marks threshold with |</summary>
        private static string BuildBar(double prob, double threshold)
        {
            int total = 14;
            int filled = (int)Math.Round(prob * total);
            filled = Math.Max(0, Math.Min(total, filled));
            int threshPos = (int)Math.Round(threshold * total);
            var sb = new System.Text.StringBuilder("[");
            for (int i = 0; i < total; i++)
            {
                if (i == threshPos) sb.Append('|');
                else sb.Append(i < filled ? '█' : '░');
            }
            sb.Append(']');
            return sb.ToString();
        }

        // ═══════════════════════════════════════════════════════════════════
        // JSON PARSING HELPERS
        // ═══════════════════════════════════════════════════════════════════
        /// <summary>Extracts a nested JSON object block {…} for a given key.</summary>
        private static string ExtractBlock(string json, string key)
        {
            try
            {
                string search = "\"" + key + "\"";
                int ki = json.IndexOf(search, StringComparison.Ordinal);
                if (ki < 0) return null;
                int ci = json.IndexOf(':', ki + search.Length);
                if (ci < 0) return null;
                int bi = json.IndexOf('{', ci + 1);
                if (bi < 0) return null;
                int depth = 1, pos = bi + 1;
                while (pos < json.Length && depth > 0)
                {
                    if      (json[pos] == '{') depth++;
                    else if (json[pos] == '}') depth--;
                    pos++;
                }
                return depth == 0 ? json.Substring(bi, pos - bi) : null;
            }
            catch { return null; }
        }

        private static string ExtractString(string json, string key)
        {
            try
            {
                string search = "\"" + key + "\"";
                int ki = json.IndexOf(search, StringComparison.Ordinal);
                if (ki < 0) return null;
                int ci = json.IndexOf(':', ki + search.Length);
                if (ci < 0) return null;
                int si = json.IndexOf('"', ci + 1);
                if (si < 0) return null;
                int ei = json.IndexOf('"', si + 1);
                if (ei < 0) return null;
                return json.Substring(si + 1, ei - si - 1);
            }
            catch { return null; }
        }

        private static double ExtractDouble(string json, string key)
        {
            try
            {
                string search = "\"" + key + "\"";
                int ki = json.IndexOf(search, StringComparison.Ordinal);
                if (ki < 0) return 0.0;
                int ci = json.IndexOf(':', ki + search.Length);
                if (ci < 0) return 0.0;
                int vi = ci + 1;
                while (vi < json.Length && (json[vi] == ' ' || json[vi] == '\t' ||
                       json[vi] == '\r' || json[vi] == '\n')) vi++;
                int end = vi;
                while (end < json.Length && json[end] != ',' &&
                       json[end] != '}' && json[end] != '\n') end++;
                string raw = json.Substring(vi, end - vi).Trim().Trim('"');
                double v;
                return double.TryParse(raw, NumberStyles.Float,
                       CultureInfo.InvariantCulture, out v) ? v : 0.0;
            }
            catch { return 0.0; }
        }

        /// <summary>
        /// Handles JSON booleans (true/false), quoted strings ("true"/"false"),
        /// and numeric (1/0).  The built-in helpers miss raw JSON booleans.
        /// </summary>
        private static bool ExtractBool(string json, string key)
        {
            try
            {
                string search = "\"" + key + "\"";
                int ki = json.IndexOf(search, StringComparison.Ordinal);
                if (ki < 0) return false;
                int ci = json.IndexOf(':', ki + search.Length);
                if (ci < 0) return false;
                int vi = ci + 1;
                while (vi < json.Length && (json[vi] == ' ' || json[vi] == '\t' ||
                       json[vi] == '\r' || json[vi] == '\n')) vi++;
                if (vi >= json.Length) return false;

                // Raw JSON boolean keyword
                if (vi + 4 <= json.Length &&
                    json.Substring(vi, 4).Equals("true",  StringComparison.OrdinalIgnoreCase)) return true;
                if (vi + 5 <= json.Length &&
                    json.Substring(vi, 5).Equals("false", StringComparison.OrdinalIgnoreCase)) return false;

                // Quoted string "true"/"false"
                if (json[vi] == '"')
                {
                    int ei = json.IndexOf('"', vi + 1);
                    if (ei > vi)
                        return json.Substring(vi + 1, ei - vi - 1)
                                   .Equals("true", StringComparison.OrdinalIgnoreCase);
                }

                // Numeric 1/0
                int end = vi;
                while (end < json.Length && json[end] != ',' && json[end] != '}') end++;
                double d;
                if (double.TryParse(json.Substring(vi, end - vi).Trim(),
                    NumberStyles.Float, CultureInfo.InvariantCulture, out d))
                    return d > 0.5;
            }
            catch { }
            return false;
        }
    }
}
