#region Using declarations
using System;
using System.IO;
using System.Net.Sockets;
using System.Text;
using System.Threading;
using NinjaTrader.Cbi;
using NinjaTrader.Data;
using NinjaTrader.Gui;
using NinjaTrader.Gui.Tools;
using NinjaTrader.NinjaScript;
using NinjaTrader.NinjaScript.Strategies;
using NinjaTrader.NinjaScript.DrawingTools;
using NinjaTrader.NinjaScript.Indicators;
#endregion

namespace NinjaTrader.NinjaScript.Strategies
{
    using System.Windows;
    using System.Windows.Controls;
    using System.Windows.Media;
    using System.Windows.Input;

    public class AntigravityBotBridge : Strategy
    {
        // Settings parameters
        private string serverIP = "127.0.0.1"; // Default to localhost since bot is running on the same machine
        private int serverPort = 4000;
        
        // Socket connection fields
        private TcpClient client;
        private NetworkStream stream;
        private Thread receiveThread;
        private bool isRunning = false;
        private bool isConnected = false;

        // Visual tracking fields
        private string lastStrategy = "None Active";
        private string lastSignal = "No Signal Received Yet";

        // Draggable WPF Floating Overlay panel
        private Border wpfPanel = null;
        private TextBlock wpfTextBlock = null;   // legacy text block (still updated as fallback)
        private Canvas wpfCanvas = null;
        private Grid chartGrid = null;
        private string activeParamsText = "• RTH EMAs: Default (9/21)\n• ETH Regimes: Default (BB 2.0, RSI 30/70)";

        // ── v2 Brain Panel structured row references (set up in CreateWPFOverlay) ──
        private StackPanel brainRows           = null;
        private TextBlock  brainHeaderStatus   = null;
        private TextBlock  brainSignalArrow    = null;
        private TextBlock  brainSignalText     = null;
        private TextBlock  brainLongProbText   = null;
        private Border     brainLongProbBar    = null;
        private Border     brainLongProbThMark = null;
        private TextBlock  brainShortProbText  = null;
        private Border     brainShortProbBar   = null;
        private Border     brainShortProbThMark= null;
        private TextBlock  brainRegimeText     = null;
        private TextBlock  brainSessionText    = null;
        private TextBlock  brainSpecText       = null;
        private TextBlock  brainPositionText   = null;
        private TextBlock  brainPnLText        = null;
        private TextBlock  brainBeText         = null;
        private TextBlock  brainTrailText      = null;
        private TextBlock  brainAtrText        = null;
        private TextBlock  brainTradesText     = null;
        private TextBlock  brainModeText       = null;
        private TextBlock  brainExitsText      = null;
        private TextBlock  brainBarSentText    = null;   // "last bar sent to bot" indicator
        private const double PROB_BAR_WIDTH    = 220;

        // Bar-feed tracking — updated every time a BAR message is sent to Node
        private DateTime   _lastBarSentTime   = DateTime.MinValue;
        private int        _barsSentTotal     = 0;

        // Counts entries since last session-open. Reset in OnStateChange to
        // State.Realtime so the panel always shows today's trade count.
        private int todayTrades = 0;
        private DateTime todayDate = DateTime.MinValue;

        // Dynamic indicator parameters for real-time plot updates
        private int parsedEmaFast = 8;
        private int parsedEmaSlow = 20;
        private double parsedBbDev = 2.0;

        // Sync fields to optimize metric broadcasts
        private double lastSentBalance = -999999;
        private double lastSentRealized = -999999;
        private double lastSentUnrealized = -999999;

        // Position details and countdown targets
        private double signalStopLoss = 0;
        private double signalTakeProfit = 0;
        private double signalBreakevenPrice = 0;
        private double signalTrailingPrice = 0;
        private double currentAtr = 0.5;
        private bool isTradingEnabled = true;

        // ── Pending signal (V6 pattern) ──────────────────────────────────────
        // ExecuteSignal() runs on the WPF dispatcher thread — calling EnterLong/
        // EnterShort there silently fails in NT8 (entry methods must be called from
        // within OnBarUpdate).  Instead we STORE the signal here and execute it on
        // the very next OnBarUpdate() tick, exactly how V6's ReadSignalFile() works.
        //
        // _entryInFlight: set to true when a pending entry is queued, cleared when
        // the position fill is confirmed (OnPositionUpdate) or the entry is dropped.
        // Prevents double-entries during the gap between EnterLong/Short submission
        // and NT8's fill confirmation — a window where Position.MarketPosition can
        // still read Flat even though an order is already pending.
        private volatile bool _entryInFlight = false;
        private string _pendingAction      = null;  // "BUY" | "SELL" | null
        private int    _pendingQty         = 1;
        private double _pendingEntryPrice  = 0;
        private double _pendingSl          = 0;
        private double _pendingTp          = 0;
        private string _pendingStrategy    = "";
        private double _pendingBe          = 0;
        private double _pendingTrail       = 0;
        private bool   _pendingClose       = false; // CLOSE also deferred to OnBarUpdate

        // Brain Panel state (populated by BRAIN<TAB>json messages from Node)
        private string brainRegime       = "—";
        private string brainSession      = "—";
        private string brainAction       = "FLAT";
        private string brainSpecialist   = "—";
        private double brainLongProb     = 0;
        private double brainShortProb    = 0;
        private double brainLongTh       = 0;
        private double brainShortTh      = 0;
        private double brainClose        = 0;
        private double brainAtr          = 0;
        private string brainContractMode = "MINI";
        private string brainTradingMode  = "paper";
        private string brainExitMode     = "ATR";
        private string brainGate         = "gate1";  // "gate1" | "gate2"
        private string brainPattern      = "";        // Gate 2 pattern name (FVG, ORB, etc.)
        private string brainFeatures     = "";
        private DateTime brainLastUpdate = DateTime.MinValue;

        // ── EOD halt + prop firm daily loss gate ─────────────────────────
        private bool   eodHaltApplied    = false;   // set at 4:45 PM ET — blocks new entries
        private bool   forceFlatApplied  = false;   // set at 4:58 PM ET — exits all positions
        private double dailyLossRealized = 0;       // cumulative realized loss today
        private double dailyLossStart    = 0;       // start-of-day realized P&L baseline
        private bool   dailyLossBaseSet  = false;   // true once baseline is captured
        private DateTime dailyLossDate   = DateTime.MinValue;
        private const double PROP_FIRM_DAILY_LOSS_LIMIT = 500.0; // $500 max daily drawdown

        protected override void OnStateChange()
        {
            if (State == State.SetDefaults)
            {
                Description                                  = "Antigravity v2 Socket Execution Bridge — dual-gate (Gate1/Gate2) + EOD halt + prop firm daily-loss gate";
                Name                                         = "AntigravityBotBridge";
                Calculate                                    = Calculate.OnEachTick;
                EntriesPerDirection                          = 1;
                EntryHandling                                = EntryHandling.UniqueEntries;
                IsExitOnSessionCloseStrategy                 = true;
                ExitOnSessionCloseSeconds                    = 30;
                IsFillLimitOnTouch                           = true;
                
                // Expose settings in properties
                AddPlot(new Stroke(System.Windows.Media.Brushes.Cyan, 2), PlotStyle.Line, "EMAFast");
                AddPlot(new Stroke(System.Windows.Media.Brushes.Magenta, 2), PlotStyle.Line, "EMASlow");
                AddPlot(new Stroke(System.Windows.Media.Brushes.Orange, 1), PlotStyle.Line, "BBUpper");
                AddPlot(new Stroke(System.Windows.Media.Brushes.Orange, 1), PlotStyle.Line, "BBLower");
            }
            else if (State == State.Configure)
            {
            }
            else if (State == State.Realtime)
            {
                // Connect to Node.js local TCP bridge when transition to real-time charting
                StartConnection();
                // Create draggable visual panel
                CreateWPFOverlay();
            }
            else if (State == State.Terminated)
            {
                StopConnection();
                // Clean up visual overlays
                RemoveWPFOverlay();
            }
        }

        protected override void OnBarUpdate()
        {
            if (CurrentBar < 40) return;

            // ── EOD halt + force-flat (ET timezone, handles DST) ─────────
            // Offset: EDT = UTC-4 (Mar second-Sun through Nov first-Sun), EST = UTC-5
            {
                DateTime utcNow = DateTime.UtcNow;
                int monthNum    = utcNow.Month;
                bool isDst      = (monthNum > 3 && monthNum < 11)
                               || (monthNum == 3  && utcNow.Day >= 8)
                               || (monthNum == 11 && utcNow.Day <  7);
                int offsetHrs   = isDst ? 4 : 5;
                DateTime etNow  = utcNow.AddHours(-offsetHrs);
                int etMins      = etNow.Hour * 60 + etNow.Minute;

                // 4:45 PM ET = 16*60+45 = 1005 — halt new entries
                if (!eodHaltApplied && etMins >= 1005)
                {
                    eodHaltApplied = true;
                    Print("AntigravityBridge: EOD halt triggered (4:45 PM ET). No new entries until next session.");
                }
                // Reset halt flag early next morning (4:00 AM ET = 240 mins)
                if (eodHaltApplied && etMins < 240)
                {
                    eodHaltApplied    = false;
                    forceFlatApplied  = false;
                    Print("AntigravityBridge: EOD halt reset (4:00 AM ET).");
                }

                // 4:58 PM ET = 16*60+58 = 1018 — force-flat all positions
                if (!forceFlatApplied && etMins >= 1018 && etMins < 1080)
                {
                    forceFlatApplied = true;
                    if (Position.MarketPosition != MarketPosition.Flat)
                    {
                        Print("AntigravityBridge: Force-flat triggered (4:58 PM ET). Exiting all positions.");
                        if (Position.MarketPosition == MarketPosition.Long)  ExitLong();
                        if (Position.MarketPosition == MarketPosition.Short) ExitShort();
                    }
                }
            }

            // ── Daily loss cap baseline capture ──────────────────────────
            if (Account != null)
            {
                DateTime today = (CurrentBar > 0) ? Time[0].Date : DateTime.Now.Date;
                if (!dailyLossBaseSet || today != dailyLossDate)
                {
                    dailyLossStart   = Account.Get(AccountItem.RealizedProfitLoss, Currency.UsDollar);
                    dailyLossBaseSet = true;
                    dailyLossDate    = today;
                }
                double realizedToday = Account.Get(AccountItem.RealizedProfitLoss, Currency.UsDollar) - dailyLossStart;
                // Negative = loss. Check if loss exceeds limit.
                if (realizedToday < -PROP_FIRM_DAILY_LOSS_LIMIT && isTradingEnabled)
                {
                    isTradingEnabled = false;
                    Print(string.Format("AntigravityBridge: DAILY LOSS CAP hit (${0:F2} realized today). Halting trading.", -realizedToday));
                    if (Position.MarketPosition == MarketPosition.Long)  ExitLong();
                    if (Position.MarketPosition == MarketPosition.Short) ExitShort();
                    UpdateChartOverlay();
                }
            }

            // ── Deferred CLOSE (V6 pattern — execute on NT8 thread) ──────────
            if (_pendingClose)
            {
                _pendingClose = false;
                if (Position.MarketPosition == MarketPosition.Long)  { ExitLong();  Print("AntigravityBridge: Deferred CLOSE — ExitLong fired from OnBarUpdate."); }
                if (Position.MarketPosition == MarketPosition.Short) { ExitShort(); Print("AntigravityBridge: Deferred CLOSE — ExitShort fired from OnBarUpdate."); }
            }

            // ── Deferred BUY / SELL (V6 pattern — execute on NT8 thread) ────
            // ExecuteSignal() only STORES the pending signal (dispatcher thread
            // cannot call EnterLong/EnterShort).  We execute it here, on the next
            // OnBarUpdate() tick — the only valid context for NT8 entry methods.
            if (_pendingAction != null)
            {
                string act = _pendingAction;
                _pendingAction = null;  // clear immediately — prevent double-fire

                if (isTradingEnabled && !eodHaltApplied && Position.MarketPosition == MarketPosition.Flat)
                {
                    string entryTag = (act == "BUY") ? "AntigravityLong" : "AntigravityShort";
                    double slTicks  = Math.Abs(_pendingEntryPrice - _pendingSl)  / TickSize;
                    double tpTicks  = Math.Abs(_pendingTp - _pendingEntryPrice)  / TickSize;
                    signalStopLoss       = _pendingSl;
                    signalTakeProfit     = _pendingTp;
                    signalBreakevenPrice = _pendingBe;
                    signalTrailingPrice  = _pendingTrail;
                    lastStrategy         = _pendingStrategy;
                    SetStopLoss(entryTag,     CalculationMode.Ticks, slTicks,  false);
                    SetProfitTarget(entryTag, CalculationMode.Ticks, tpTicks);
                    if (act == "BUY")
                    {
                        Print(string.Format("AntigravityBridge: Deferred BUY fired from OnBarUpdate. Qty={0} SL={1:F0}t TP={2:F0}t", _pendingQty, slTicks, tpTicks));
                        EnterLong(_pendingQty, "AntigravityLong");
                        BumpTodayTrades();
                        // _entryInFlight stays true until OnPositionUpdate confirms the fill
                    }
                    else
                    {
                        Print(string.Format("AntigravityBridge: Deferred SELL fired from OnBarUpdate. Qty={0} SL={1:F0}t TP={2:F0}t", _pendingQty, slTicks, tpTicks));
                        EnterShort(_pendingQty, "AntigravityShort");
                        BumpTodayTrades();
                        // _entryInFlight stays true until OnPositionUpdate confirms the fill
                    }
                }
                else
                {
                    _entryInFlight = false;  // entry dropped — clear so next signal can queue
                    Print(string.Format("AntigravityBridge: Deferred {0} DROPPED — tradingEnabled={1} eodHalt={2} pos={3}", act, isTradingEnabled, eodHaltApplied, Position.MarketPosition));
                }
            }

            if (Position.MarketPosition == MarketPosition.Flat)
            {
                signalStopLoss = 0;
                signalTakeProfit = 0;
                signalBreakevenPrice = 0;
                signalTrailingPrice = 0;
                beApplied = false;
                trailApplied = false;
            }
            else
            {
                currentAtr = ATR(14)[0];
                // ── Break-even + trailing stop management ──
                // Python brain set signalBreakevenPrice and signalTrailingPrice
                // when entry was submitted. When price crosses them, advance SL.
                ManageBreakevenAndTrail();
            }
            UpdateChartOverlay();

            // Dynamically calculate and plot indicators using parsed variables from TCP bridge
            // 1. RTH Session Trend Crossovers (EMA Fast and Slow)
            Values[0][0] = EMA(parsedEmaFast)[0];
            Values[1][0] = EMA(parsedEmaSlow)[0];

            // 2. ETH Session Mean Reversion (Bollinger Bands Upper and Lower)
            Values[2][0] = Bollinger(parsedBbDev, 20).Upper[0];
            Values[3][0] = Bollinger(parsedBbDev, 20).Lower[0];

            // ── Bar push to Node decision engine ──
            // Only on first tick of a new bar (closed-bar inference).
            if (isConnected && stream != null && IsFirstTickOfBar && CurrentBar >= 220)
            {
                try
                {
                    string sym = ResolveSymbolCode();
                    // BAR,symbol,iso8601,open,high,low,close,volume
                    string barMsg = string.Format("BAR,{0},{1:yyyy-MM-ddTHH:mm:ss},{2},{3},{4},{5},{6}\n",
                        sym, Time[1], Open[1], High[1], Low[1], Close[1], (long)Volume[1]);
                    byte[] buf = Encoding.UTF8.GetBytes(barMsg);
                    stream.Write(buf, 0, buf.Length);
                    _lastBarSentTime = DateTime.Now;
                    _barsSentTotal++;
                }
                catch {}
            }

            // Real-time synchronization of account metrics (Balance, Realized, and Unrealized P&Ls)
            if (isConnected && stream != null && Account != null)
            {
                try
                {
                    double currentBalance = Account.Get(AccountItem.NetLiquidation, Currency.UsDollar);
                    double currentRealized = Account.Get(AccountItem.RealizedProfitLoss, Currency.UsDollar);
                    double currentUnrealized = Account.Get(AccountItem.UnrealizedProfitLoss, Currency.UsDollar);

                    if (Math.Abs(currentBalance - lastSentBalance) > 0.01 ||
                        Math.Abs(currentRealized - lastSentRealized) > 0.01 ||
                        Math.Abs(currentUnrealized - lastSentUnrealized) > 0.01)
                    {
                        string symbol = ResolveSymbolCode();
                        // Extended METRICS v2 — includes authoritative position info
                        // so Node doesn't have to guess direction from sign of P&L.
                        string posLabel = Position.MarketPosition == MarketPosition.Long ? "Long"
                                        : Position.MarketPosition == MarketPosition.Short ? "Short"
                                        : "Flat";
                        int posQty = Position.Quantity;
                        double avgPrice = Position.AveragePrice;
                        string metricsMsg = string.Format("METRICS,{0},{1},{2},{3},{4},{5},{6}\n",
                            symbol, currentBalance, currentRealized, currentUnrealized, posLabel, posQty, avgPrice);
                        byte[] writeBuffer = Encoding.UTF8.GetBytes(metricsMsg);
                        stream.Write(writeBuffer, 0, writeBuffer.Length);

                        lastSentBalance = currentBalance;
                        lastSentRealized = currentRealized;
                        lastSentUnrealized = currentUnrealized;
                    }
                }
                catch {}
            }
        }

        // Resolves Yahoo-style symbol code from current chart instrument.
        // MICRO check MUST come before MINI — both contain the 2-char family
        // ("MNQ" contains "NQ"), so the order matters.
        private string ResolveSymbolCode()
        {
            string name = Instrument.FullName.ToUpper();
            // Micros first
            if (name.StartsWith("MNQ")) return "MNQ=F";
            if (name.StartsWith("MES")) return "MES=F";
            if (name.StartsWith("MCL")) return "MCL=F";
            if (name.StartsWith("MGC")) return "MGC=F";
            // Then minis
            if (name.StartsWith("NQ"))  return "NQ=F";
            if (name.StartsWith("ES"))  return "ES=F";
            if (name.StartsWith("CL"))  return "CL=F";
            if (name.StartsWith("GC"))  return "GC=F";
            return "NQ=F";
        }

        // Clear the in-flight guard as soon as NT8 confirms the position fill.
        // This is the earliest reliable moment: Position.MarketPosition has changed
        // from Flat → Long/Short, meaning the entry order was accepted and filled.
        // Any new signal that arrives after this point will see a non-Flat position
        // and be correctly blocked by the existing position check.
        protected override void OnPositionUpdate(Position position, double averagePrice,
                                                  int quantity, MarketPosition marketPosition)
        {
            if (marketPosition != MarketPosition.Flat)
            {
                _entryInFlight = false;  // fill confirmed — allow next entry after exit
            }
        }

        // Increment today's trade counter, auto-resetting at calendar-day rollover
        // so the panel always shows the current trading day's count.
        private void BumpTodayTrades()
        {
            DateTime today = (CurrentBar > 0) ? Time[0].Date : DateTime.Now.Date;
            if (today != todayDate)
            {
                todayDate = today;
                todayTrades = 0;
            }
            todayTrades++;
        }

        // State for BE/trail (declared as fields below in #region)
        private bool beApplied = false;
        private bool trailApplied = false;

        // Moves SL to breakeven once price crosses signalBreakevenPrice, and
        // starts trailing once price crosses signalTrailingPrice. SL only
        // advances in our favor (never backs off).
        private void ManageBreakevenAndTrail()
        {
            if (Position.MarketPosition == MarketPosition.Flat) return;
            if (signalBreakevenPrice <= 0 || signalTrailingPrice <= 0) return;

            double px = Close[0];
            double entry = Position.AveragePrice;
            bool isLong = Position.MarketPosition == MarketPosition.Long;

            // Stage 1: Break-even
            if (!beApplied)
            {
                bool beHit = isLong ? px >= signalBreakevenPrice : px <= signalBreakevenPrice;
                if (beHit)
                {
                    double newSL = entry; // pure breakeven
                    double slTicks = Math.Abs(px - newSL) / TickSize;
                    try
                    {
                        SetStopLoss(isLong ? "AntigravityLong" : "AntigravityShort",
                                    CalculationMode.Price, newSL, false);
                        beApplied = true;
                        signalStopLoss = newSL;
                        Print(string.Format("AntigravityBridge: BE applied @ {0:F2}", newSL));
                    }
                    catch (Exception ex) { Print("BE move error: " + ex.Message); }
                }
            }

            // Stage 2: Trailing — starts immediately when BE fires (no separate trigger gate).
            // Trail distance = 1.0 × ATR (V6 spec — matches gate2Engine.js trailingDistance).
            // The stop only ever advances (ratchets up for longs, down for shorts).
            if (beApplied)
            {
                double trailDist = currentAtr > 0 ? currentAtr * 1.0 : (TickSize * 20);
                double newSL = isLong ? px - trailDist : px + trailDist;
                bool advances = isLong ? newSL > signalStopLoss : newSL < signalStopLoss;
                if (advances)
                {
                    try
                    {
                        SetStopLoss(isLong ? "AntigravityLong" : "AntigravityShort",
                                    CalculationMode.Price, newSL, false);
                        signalStopLoss = newSL;
                        trailApplied = true;
                        Print(string.Format("AntigravityBridge: Trail advanced → SL {0:F2} (dist {1:F2} pts)", newSL, trailDist));
                    }
                    catch (Exception ex) { Print("Trail move error: " + ex.Message); }
                }
            }
        }

        private void StartConnection()
        {
            if (isRunning) return;
            
            isRunning = true;
            receiveThread = new Thread(new ThreadStart(ConnectionLoop));
            receiveThread.IsBackground = true;
            receiveThread.Start();
            
            Print("AntigravityBridge: Background socket thread started.");
        }

        private void StopConnection()
        {
            isRunning = false;
            isConnected = false;
            
            if (stream != null) { stream.Close(); stream = null; }
            if (client != null) { client.Close(); client = null; }
            
            Print("AntigravityBridge: Background socket thread terminated.");
            UpdateChartOverlay();
        }

        // Dedicated connection and execution thread
        private void ConnectionLoop()
        {
            while (isRunning)
            {
                if (!isConnected)
                {
                    try
                    {
                        Print(string.Format("AntigravityBridge: Attempting connection to {0}:{1}...", serverIP, serverPort));
                        client = new TcpClient(serverIP, serverPort);
                        stream = client.GetStream();
                        isConnected = true;
                        Print("AntigravityBridge: Connected successfully to Antigravity Bot!");

                        // Transmit the active account for this symbol assigned on the chart to the Node.js server.
                        // MICRO check MUST come before MINI — "MNQ".Contains("NQ") is true.
                        // Use the shared resolver so this stays consistent with ResolveSymbolCode().
                        string symbol = ResolveSymbolCode();

                        string accountName = (Account != null) ? Account.Name : "Sim101";
                        string accountMsg = string.Format("ACCOUNT,{0},{1}\n", symbol, accountName);
                        byte[] writeBuffer = Encoding.UTF8.GetBytes(accountMsg);
                        stream.Write(writeBuffer, 0, writeBuffer.Length);
                        Print(string.Format("AntigravityBridge: Transmitted active chart account -> ACCOUNT,{0},{1}", symbol, accountName));

                        // Transmit initial account balance, realized and unrealized P&L metrics immediately upon connection handshake
                        if (Account != null)
                        {
                            double currentBalance = Account.Get(AccountItem.NetLiquidation, Currency.UsDollar);
                            double currentRealized = Account.Get(AccountItem.RealizedProfitLoss, Currency.UsDollar);
                            double currentUnrealized = Account.Get(AccountItem.UnrealizedProfitLoss, Currency.UsDollar);

                            string posLabel = Position.MarketPosition == MarketPosition.Long ? "Long"
                                            : Position.MarketPosition == MarketPosition.Short ? "Short"
                                            : "Flat";
                            int posQty = Position.Quantity;
                            double avgPrice = Position.AveragePrice;
                            string metricsMsg = string.Format("METRICS,{0},{1},{2},{3},{4},{5},{6}\n",
                                symbol, currentBalance, currentRealized, currentUnrealized, posLabel, posQty, avgPrice);
                            byte[] metricsBuf = Encoding.UTF8.GetBytes(metricsMsg);
                            stream.Write(metricsBuf, 0, metricsBuf.Length);

                            lastSentBalance = currentBalance;
                            lastSentRealized = currentRealized;
                            lastSentUnrealized = currentUnrealized;
                            Print(string.Format("AntigravityBridge: Initial metrics sync -> METRICS,{0},{1},{2},{3} pos={4} qty={5}",
                                symbol, currentBalance, currentRealized, currentUnrealized, posLabel, posQty));
                        }
                        
                        // Force a UI label refresh on connect
                        UpdateChartOverlay();
                    }
                    catch (Exception ex)
                    {
                        Print("AntigravityBridge: Connection failed. Retrying in 10 seconds... Error: " + ex.Message);
                        UpdateChartOverlay();
                        Thread.Sleep(10000);
                        continue;
                    }
                }

                try
                {
                    // Buffer 8192 bytes — BRAIN packets are ~500-900 bytes each,
                    // and when 4 families' bars all close near-simultaneously the
                    // server broadcasts 4 packets in quick succession which can
                    // exceed 1024 → truncation → silent JSON parse failure.
                    // Found 2026-05-26.
                    byte[] buffer = new byte[8192];
                    int bytesRead = stream.Read(buffer, 0, buffer.Length);
                    
                    if (bytesRead == 0)
                    {
                        // Server closed connection
                        isConnected = false;
                        Print("AntigravityBridge: Connection lost from server.");
                        UpdateChartOverlay();
                        continue;
                    }

                    string data = Encoding.UTF8.GetString(buffer, 0, bytesRead).Trim();
                    string[] commands = data.Split('\n');

                    foreach (string cmd in commands)
                    {
                        if (string.IsNullOrEmpty(cmd)) continue;
                        
                        Print("AntigravityBridge: Inbound Signal -> " + cmd);
                        
                        // Execute order signals on the main NinjaScript thread safely
                        NinjaTrader.Core.Globals.RandomDispatcher.BeginInvoke(new Action(() => {
                            ExecuteSignal(cmd);
                        }));
                    }
                }
                catch (Exception ex)
                {
                    if (isRunning)
                    {
                        isConnected = false;
                        Print("AntigravityBridge: Read exception. Connection lost: " + ex.Message);
                        UpdateChartOverlay();
                    }
                }
            }
        }

        // Create draggable WPF Overlay dynamically
        // ─────────────────────────────────────────────────────────────────
        // v2 Brain Panel layout — structured rows with colored labels +
        // probability bars, matching V6's visual style.
        // ─────────────────────────────────────────────────────────────────
        // Frozen brushes are immutable and safe to use across WPF threads (no dispatcher affinity).
        // Creating an un-frozen SolidColorBrush on the static-init thread then setting it as
        // Foreground/Background on a WPF element from the Dispatcher thread throws:
        //   "Cannot use a DependencyObject that belongs to a different thread than its parent Freezable."
        private static SolidColorBrush FrozenRgb(byte r, byte g, byte b)
        {
            var br = new SolidColorBrush(Color.FromRgb(r, g, b));
            br.Freeze();
            return br;
        }
        private static SolidColorBrush FrozenArgb(byte a, byte r, byte g, byte b)
        {
            var br = new SolidColorBrush(Color.FromArgb(a, r, g, b));
            br.Freeze();
            return br;
        }

        private static readonly SolidColorBrush COL_LABEL  = FrozenRgb(0, 240, 255);      // cyan
        private static readonly SolidColorBrush COL_VAL    = FrozenRgb(245, 246, 248);    // near-white
        private static readonly SolidColorBrush COL_MUTED  = FrozenRgb(154, 160, 166);    // grey
        private static readonly SolidColorBrush COL_GREEN  = FrozenRgb(57, 255, 20);      // neon green
        private static readonly SolidColorBrush COL_RED    = FrozenRgb(255, 56, 56);      // neon red
        private static readonly SolidColorBrush COL_AMBER  = FrozenRgb(255, 152, 0);      // amber
        private static readonly SolidColorBrush COL_PURPLE = FrozenRgb(167, 139, 250);    // purple
        private static readonly SolidColorBrush COL_BARBG  = FrozenArgb(80, 60, 70, 90);  // bar track
        private static readonly SolidColorBrush COL_DIVIDER= FrozenArgb(40, 255, 255, 255);

        private StackPanel BuildBrainPanelLayout()
        {
            var root = new StackPanel { Orientation = Orientation.Vertical };

            // ── Header row: bolt + brand + status pill ─────────────────────
            var headerRow = new Grid();
            headerRow.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
            headerRow.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            var hLeft = new TextBlock {
                Text = "⚡ ANTIGRAVITY v2 BRAIN",
                Foreground = COL_LABEL,
                FontFamily = new FontFamily("Segoe UI"),
                FontSize = 15,
                FontWeight = FontWeights.Bold
            };
            brainHeaderStatus = new TextBlock {
                Text = "● connecting",
                Foreground = COL_MUTED,
                FontFamily = new FontFamily("Segoe UI"),
                FontSize = 12,
                FontWeight = FontWeights.Bold,
                HorizontalAlignment = HorizontalAlignment.Right,
                VerticalAlignment = VerticalAlignment.Center
            };
            Grid.SetColumn(hLeft, 0); Grid.SetColumn(brainHeaderStatus, 1);
            headerRow.Children.Add(hLeft); headerRow.Children.Add(brainHeaderStatus);
            root.Children.Add(headerRow);
            root.Children.Add(MakeDivider(8));

            // ── Signal row ────────────────────────────────────────────────
            brainSignalArrow = new TextBlock { Text = "—", Foreground = COL_MUTED, FontFamily = new FontFamily("Consolas"), FontSize = 15, FontWeight = FontWeights.Bold, Margin = new Thickness(6, 0, 0, 0) };
            brainSignalText  = new TextBlock { Text = "WAIT",  Foreground = COL_MUTED, FontFamily = new FontFamily("Consolas"), FontSize = 15, FontWeight = FontWeights.Bold, Margin = new Thickness(8, 0, 0, 0) };
            root.Children.Add(MakeRow("Signal", new UIElement[] { brainSignalArrow, brainSignalText }));

            // ── Long probability bar ──────────────────────────────────────
            brainLongProbText = new TextBlock { Text = "0.00", Foreground = COL_GREEN, FontFamily = new FontFamily("Consolas"), FontSize = 14, FontWeight = FontWeights.Bold, Width = 50, TextAlignment = TextAlignment.Right };
            brainLongProbBar  = MakeProbBar(COL_GREEN);
            brainLongProbThMark = MakeThMark();
            root.Children.Add(MakeProbRow("Long P", brainLongProbText, brainLongProbBar, brainLongProbThMark));

            // ── Short probability bar ─────────────────────────────────────
            brainShortProbText = new TextBlock { Text = "0.00", Foreground = COL_RED, FontFamily = new FontFamily("Consolas"), FontSize = 14, FontWeight = FontWeights.Bold, Width = 50, TextAlignment = TextAlignment.Right };
            brainShortProbBar  = MakeProbBar(COL_RED);
            brainShortProbThMark = MakeThMark();
            root.Children.Add(MakeProbRow("Short P", brainShortProbText, brainShortProbBar, brainShortProbThMark));

            // ── Regime + Session row ──────────────────────────────────────
            brainRegimeText = new TextBlock { Text = "—",      Foreground = COL_AMBER, FontFamily = new FontFamily("Consolas"), FontSize = 14, FontWeight = FontWeights.Bold, Margin = new Thickness(6, 0, 0, 0) };
            brainSessionText= new TextBlock { Text = "—",      Foreground = COL_MUTED, FontFamily = new FontFamily("Consolas"), FontSize = 13, FontWeight = FontWeights.Bold, Margin = new Thickness(12, 0, 0, 0) };
            root.Children.Add(MakeRow("Regime", new UIElement[] { brainRegimeText, brainSessionText }));

            // ── Specialist row (small monospace) ──────────────────────────
            brainSpecText = new TextBlock { Text = "awaiting first bar push…", Foreground = COL_VAL, FontFamily = new FontFamily("Consolas"), FontSize = 12, FontWeight = FontWeights.Bold, Margin = new Thickness(6, 0, 0, 0), TextWrapping = TextWrapping.NoWrap };
            root.Children.Add(MakeRow("Spec",   new UIElement[] { brainSpecText }));

            root.Children.Add(MakeDivider(8));

            // ── Position + P&L rows ───────────────────────────────────────
            brainPositionText = new TextBlock { Text = "FLAT",      Foreground = COL_MUTED, FontFamily = new FontFamily("Consolas"), FontSize = 14, FontWeight = FontWeights.Bold, Margin = new Thickness(6, 0, 0, 0) };
            brainPnLText      = new TextBlock { Text = "—",         Foreground = COL_MUTED, FontFamily = new FontFamily("Consolas"), FontSize = 14, FontWeight = FontWeights.Bold, Margin = new Thickness(6, 0, 0, 0) };
            root.Children.Add(MakeRow("Position", new UIElement[] { brainPositionText }));
            root.Children.Add(MakeRow("P & L",    new UIElement[] { brainPnLText }));

            // ── BE / Trail countdowns ─────────────────────────────────────
            brainBeText    = new TextBlock { Text = "—", Foreground = COL_VAL,   FontFamily = new FontFamily("Consolas"), FontSize = 13, FontWeight = FontWeights.Bold, Margin = new Thickness(6, 0, 0, 0) };
            brainTrailText = new TextBlock { Text = "—", Foreground = COL_VAL,   FontFamily = new FontFamily("Consolas"), FontSize = 13, FontWeight = FontWeights.Bold, Margin = new Thickness(6, 0, 0, 0) };
            root.Children.Add(MakeRow("BE in",    new UIElement[] { brainBeText }));
            root.Children.Add(MakeRow("Trail in", new UIElement[] { brainTrailText }));

            root.Children.Add(MakeDivider(8));

            // ── Footer: ATR + Trades + Mode + Exits ───────────────────────
            brainAtrText    = new TextBlock { Text = "—",      Foreground = COL_VAL, FontFamily = new FontFamily("Consolas"), FontSize = 13, FontWeight = FontWeights.Bold, Margin = new Thickness(6, 0, 12, 0) };
            brainTradesText = new TextBlock { Text = "—",      Foreground = COL_VAL, FontFamily = new FontFamily("Consolas"), FontSize = 13, FontWeight = FontWeights.Bold, Margin = new Thickness(0, 0, 0, 0) };
            var atrTradesRow = new Grid();
            atrTradesRow.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(70) });
            atrTradesRow.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
            atrTradesRow.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            atrTradesRow.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(78) });
            atrTradesRow.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
            atrTradesRow.Margin = new Thickness(0, 4, 0, 4);
            var atrLabel    = new TextBlock { Text = "ATR :",    Foreground = COL_LABEL, FontFamily = new FontFamily("Consolas"), FontSize = 13, FontWeight = FontWeights.Bold };
            var tradesLabel = new TextBlock { Text = "Trades :", Foreground = COL_LABEL, FontFamily = new FontFamily("Consolas"), FontSize = 13, FontWeight = FontWeights.Bold };
            Grid.SetColumn(atrLabel, 0);    Grid.SetColumn(brainAtrText, 1);
            Grid.SetColumn(tradesLabel, 3); Grid.SetColumn(brainTradesText, 4);
            atrTradesRow.Children.Add(atrLabel);
            atrTradesRow.Children.Add(brainAtrText);
            atrTradesRow.Children.Add(tradesLabel);
            atrTradesRow.Children.Add(brainTradesText);
            root.Children.Add(atrTradesRow);

            brainModeText  = new TextBlock { Text = "MINI · PAPER", Foreground = COL_AMBER,  FontFamily = new FontFamily("Consolas"), FontSize = 12, FontWeight = FontWeights.Bold, Margin = new Thickness(6, 0, 0, 0) };
            brainExitsText = new TextBlock { Text = "Exits: ATR",   Foreground = COL_VAL,    FontFamily = new FontFamily("Consolas"), FontSize = 12, FontWeight = FontWeights.Bold, Margin = new Thickness(6, 0, 0, 0) };
            root.Children.Add(MakeRow("Mode",  new UIElement[] { brainModeText }));
            root.Children.Add(MakeRow("Exits", new UIElement[] { brainExitsText }));

            // ── Bar-feed health row ───────────────────────────────────────────
            root.Children.Add(MakeDivider(6));
            brainBarSentText = new TextBlock {
                Text       = "● waiting for first bar…",
                Foreground = COL_MUTED,
                FontFamily = new FontFamily("Consolas"),
                FontSize   = 12,
                FontWeight = FontWeights.Bold,
                Margin     = new Thickness(6, 0, 0, 0)
            };
            root.Children.Add(MakeRow("Bar→Bot", new UIElement[] { brainBarSentText }));

            return root;
        }

        // Builds a "label : value(s)" row with a fixed-width label column.
        private Grid MakeRow(string label, UIElement[] valueCells)
        {
            var row = new Grid();
            row.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(94) });
            row.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            row.Margin = new Thickness(0, 4, 0, 4);
            var lbl = new TextBlock {
                Text = label + " :",
                Foreground = COL_LABEL,
                FontFamily = new FontFamily("Consolas"),
                FontSize = 13,
                FontWeight = FontWeights.Bold
            };
            Grid.SetColumn(lbl, 0);
            row.Children.Add(lbl);
            var stack = new StackPanel { Orientation = Orientation.Horizontal };
            foreach (var el in valueCells) stack.Children.Add(el);
            Grid.SetColumn(stack, 1);
            row.Children.Add(stack);
            return row;
        }

        // Probability row: "label :  [bar]  value"
        private Grid MakeProbRow(string label, TextBlock valueText, Border barFill, Border thMark)
        {
            var row = new Grid();
            row.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(94) });
            row.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
            row.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            row.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
            row.Margin = new Thickness(0, 5, 0, 5);

            var lbl = new TextBlock { Text = label + " :", Foreground = COL_LABEL, FontFamily = new FontFamily("Consolas"), FontSize = 13, FontWeight = FontWeights.Bold, VerticalAlignment = VerticalAlignment.Center };
            Grid.SetColumn(lbl, 0);
            row.Children.Add(lbl);

            // Bar track (background)
            var track = new Border {
                Width = PROB_BAR_WIDTH,
                Height = 14,
                Background = COL_BARBG,
                CornerRadius = new CornerRadius(3),
                Margin = new Thickness(6, 0, 6, 0),
                VerticalAlignment = VerticalAlignment.Center
            };
            // Bar fill (foreground) — width = 0 initially, sized by Update
            barFill.HorizontalAlignment = HorizontalAlignment.Left;
            barFill.Width = 0;
            barFill.Height = 14;
            barFill.CornerRadius = new CornerRadius(3);
            // Threshold tick
            thMark.HorizontalAlignment = HorizontalAlignment.Left;
            thMark.Width = 2;
            thMark.Height = 18;
            { var _b = new SolidColorBrush(Colors.White); _b.Freeze(); thMark.Background = _b; }
            thMark.Margin = new Thickness(0, -2, 0, -2);
            var trackGrid = new Grid();
            trackGrid.Children.Add(barFill);
            trackGrid.Children.Add(thMark);
            track.Child = trackGrid;
            Grid.SetColumn(track, 1);
            row.Children.Add(track);

            // Value text
            Grid.SetColumn(valueText, 3);
            valueText.VerticalAlignment = VerticalAlignment.Center;
            row.Children.Add(valueText);
            return row;
        }

        private Border MakeProbBar(SolidColorBrush color) { return new Border { Background = color }; }
        private Border MakeThMark() { return new Border(); }

        private Border MakeDivider(double topMargin)
        {
            return new Border {
                Height = 1,
                Background = COL_DIVIDER,
                Margin = new Thickness(0, topMargin, 0, topMargin)
            };
        }

        private void CreateWPFOverlay()
        {
            if (ChartControl == null) return;
            
            ChartControl.Dispatcher.InvokeAsync(new Action(() => {
                try
                {
                    chartGrid = (Grid)ChartControl.Parent;
                    if (chartGrid == null) return;

                    // 1. Create a transparent Canvas over the chart
                    wpfCanvas = new Canvas();
                    wpfCanvas.IsHitTestVisible = true;
                    chartGrid.Children.Add(wpfCanvas);

                    // 2. Create the futuristic charcoal glass border
                    wpfPanel = new Border();
                    { var _bg = new SolidColorBrush(Color.FromArgb(230, 10, 12, 18)); _bg.Freeze(); wpfPanel.Background = _bg; } // Glassy dark
                    { var _bb = new SolidColorBrush(Color.FromRgb(0, 240, 255));      _bb.Freeze(); wpfPanel.BorderBrush = _bb; } // Cyan glow
                    wpfPanel.BorderThickness = new Thickness(1.5);
                    wpfPanel.CornerRadius = new CornerRadius(10);
                    wpfPanel.Width = 525;
                    wpfPanel.Padding = new Thickness(18, 16, 18, 16);
                    wpfPanel.Cursor = Cursors.SizeAll;

                    // Position it initially in top-left offset
                    Canvas.SetLeft(wpfPanel, 40);
                    Canvas.SetTop(wpfPanel, 80);

                    // 3. Build the v2 Brain Panel layout
                    brainRows = BuildBrainPanelLayout();
                    wpfPanel.Child = brainRows;

                    // 4. Draggable Event Handlers
                    bool isDragging = false;
                    Point dragStart = new Point();
                    double startLeft = 0;
                    double startTop = 0;

                    wpfPanel.MouseLeftButtonDown += (s, e) => {
                        isDragging = true;
                        dragStart = e.GetPosition(wpfCanvas);
                        startLeft = Canvas.GetLeft(wpfPanel);
                        startTop = Canvas.GetTop(wpfPanel);
                        wpfPanel.CaptureMouse();
                        e.Handled = true;
                    };

                    wpfPanel.MouseMove += (s, e) => {
                        if (isDragging) {
                            Point curPos = e.GetPosition(wpfCanvas);
                            double newLeft = startLeft + (curPos.X - dragStart.X);
                            double newTop  = startTop  + (curPos.Y - dragStart.Y);
                            // Free placement — no bounds clamp so panel goes anywhere.
                            // (Previous clamp used wpfPanel.Height which is NaN for
                            // auto-sized content → Math.Min(NaN,y)=NaN → SetTop(NaN)
                            // silently froze vertical drag. Fix: just set directly.)
                            Canvas.SetLeft(wpfPanel, newLeft);
                            Canvas.SetTop(wpfPanel, newTop);
                            e.Handled = true;
                        }
                    };

                    wpfPanel.MouseLeftButtonUp += (s, e) => {
                        isDragging = false;
                        wpfPanel.ReleaseMouseCapture();
                        e.Handled = true;
                    };

                    wpfCanvas.Children.Add(wpfPanel);
                    UpdateChartOverlay();
                }
                catch (Exception ex)
                {
                    Print("AntigravityBridge: Failed to create WPF overlay. Error: " + ex.Message);
                }
            }));
        }

        private void RemoveWPFOverlay()
        {
            if (ChartControl == null) return;
            
            ChartControl.Dispatcher.InvokeAsync(new Action(() => {
                try
                {
                    if (wpfCanvas != null && chartGrid != null)
                    {
                        if (wpfPanel != null) wpfCanvas.Children.Remove(wpfPanel);
                        chartGrid.Children.Remove(wpfCanvas);
                    }
                }
                catch {}
            }));
        }

        // Draw a beautiful status overlay on the NinjaTrader 8 Chart
        private void UpdateChartOverlay()
        {
            string statusText = isConnected 
                ? (isTradingEnabled ? "CONNECTED TO BOT" : "HALTED / SUSPENDED (OFF)")
                : "DISCONNECTED (RETRYING...)";
            string posInfo = isTradingEnabled ? "No Active Position (Monitoring Regimes)" : "Trading Suspended (ON/OFF switch is OFF)";
            string targetInfo = "";
            
            Color borderGlowColor = isConnected 
                ? (isTradingEnabled ? Color.FromRgb(0, 240, 255) : Color.FromRgb(255, 140, 0)) 
                : Color.FromRgb(255, 56, 56); // Cyan if connected and flat, Orange if Halted, Red if disconnected
            
            if (Position != null && Position.MarketPosition != MarketPosition.Flat)
            {
                double currentPrice = Close[0];
                double entryPrice = Position.AveragePrice;
                double pnl = Position.GetUnrealizedProfitLoss(PerformanceUnit.Currency, currentPrice);
                
                string pnlSign = pnl >= 0 ? "+" : "-";
                string pnlColorText = string.Format("{0}${1:F2}", pnlSign, Math.Abs(pnl));
                
                posInfo = string.Format("{0} {1} Contract(s) @ {2:F2}\n• Strategy Active: {3}\n• Unrealized P&L: {4}", 
                    Position.MarketPosition.ToString().ToUpper(), 
                    Position.Quantity, 
                    entryPrice, 
                    lastStrategy, 
                    pnlColorText);
                
                // Set border color based on trade direction (Long = neon green, Short = neon red)
                // Previously P&L-based; direction-based is more immediately readable at a glance.
                bool posLong = Position.MarketPosition == MarketPosition.Long;
                borderGlowColor = posLong ? Color.FromRgb(57, 255, 20) : Color.FromRgb(255, 56, 56);
                
                // Triggers calculation
                double atr = currentAtr;
                
                // Fallback calculations if trigger prices not received
                if (signalBreakevenPrice <= 0.01)
                {
                    bool isRTH = Time[0].Hour >= 9 && (Time[0].Hour < 16 || (Time[0].Hour == 16 && Time[0].Minute == 0));
                    double beMult = isRTH ? 1.2 : 0.6;
                    double trailMult = isRTH ? 1.5 : 0.8;
                    
                    signalBreakevenPrice = entryPrice + (beMult * atr * (Position.MarketPosition == MarketPosition.Long ? 1 : -1));
                    signalTrailingPrice = entryPrice + (trailMult * atr * (Position.MarketPosition == MarketPosition.Long ? 1 : -1));
                }
                
                if (signalStopLoss <= 0.01)
                {
                    bool isRTH = Time[0].Hour >= 9 && (Time[0].Hour < 16 || (Time[0].Hour == 16 && Time[0].Minute == 0));
                    double stopMult = isRTH ? 2.0 : 1.0;
                    double targetMult = isRTH ? 3.0 : 1.4;
                    
                    signalStopLoss = entryPrice - (stopMult * atr * (Position.MarketPosition == MarketPosition.Long ? 1 : -1));
                    signalTakeProfit = entryPrice + (targetMult * atr * (Position.MarketPosition == MarketPosition.Long ? 1 : -1));
                }

                // Format count downs
                string tpText = "N/A";
                string slText = "N/A";
                string beText = "N/A";
                string trailText = "N/A";

                if (Position.MarketPosition == MarketPosition.Long)
                {
                    // Take Profit
                    if (signalTakeProfit > 0)
                    {
                        double dist = signalTakeProfit - currentPrice;
                        double ticks = dist / TickSize;
                        tpText = dist > 0 
                            ? string.Format("{0:F2} (Countdown: {1:F2} pts / {2} ticks)", signalTakeProfit, dist, Math.Round(ticks))
                            : string.Format("{0:F2} (Target Reached)", signalTakeProfit);
                    }
                    
                    // Stop Loss
                    if (signalStopLoss > 0)
                    {
                        double dist = currentPrice - signalStopLoss;
                        double ticks = dist / TickSize;
                        slText = dist > 0 
                            ? string.Format("{0:F2} (Countdown: -{1:F2} pts / -{2} ticks)", signalStopLoss, dist, Math.Round(ticks))
                            : string.Format("{0:F2} (Stop Breached)", signalStopLoss);
                    }
                    
                    // Breakeven
                    double beDist = signalBreakevenPrice - currentPrice;
                    if (beDist > 0)
                    {
                        double beTicks = beDist / TickSize;
                        beText = string.Format("{0:F2} (Countdown: {1:F2} pts / {2} ticks)", signalBreakevenPrice, beDist, Math.Round(beTicks));
                    }
                    else
                    {
                        beText = string.Format("{0:F2} (ACTIVE 🛡️)", signalBreakevenPrice);
                    }
                    
                    // Trailing Stop
                    double trailDist = signalTrailingPrice - currentPrice;
                    if (trailDist > 0)
                    {
                        double trailTicks = trailDist / TickSize;
                        trailText = string.Format("{0:F2} (Countdown: {1:F2} pts / {2} ticks)", signalTrailingPrice, trailDist, Math.Round(trailTicks));
                    }
                    else
                    {
                        trailText = string.Format("{0:F2} (ACTIVE 📈)", signalTrailingPrice);
                    }
                }
                else // Short position
                {
                    // Take Profit
                    if (signalTakeProfit > 0)
                    {
                        double dist = currentPrice - signalTakeProfit;
                        double ticks = dist / TickSize;
                        tpText = dist > 0 
                            ? string.Format("{0:F2} (Countdown: {1:F2} pts / {2} ticks)", signalTakeProfit, dist, Math.Round(ticks))
                            : string.Format("{0:F2} (Target Reached)", signalTakeProfit);
                    }
                    
                    // Stop Loss
                    if (signalStopLoss > 0)
                    {
                        double dist = signalStopLoss - currentPrice;
                        double ticks = dist / TickSize;
                        slText = dist > 0 
                            ? string.Format("{0:F2} (Countdown: -{1:F2} pts / -{2} ticks)", signalStopLoss, dist, Math.Round(ticks))
                            : string.Format("{0:F2} (Stop Breached)", signalStopLoss);
                    }
                    
                    // Breakeven
                    double beDist = currentPrice - signalBreakevenPrice;
                    if (beDist > 0)
                    {
                        double beTicks = beDist / TickSize;
                        beText = string.Format("{0:F2} (Countdown: {1:F2} pts / {2} ticks)", signalBreakevenPrice, beDist, Math.Round(beTicks));
                    }
                    else
                    {
                        beText = string.Format("{0:F2} (ACTIVE 🛡️)", signalBreakevenPrice);
                    }
                    
                    // Trailing Stop
                    double trailDist = currentPrice - signalTrailingPrice;
                    if (trailDist > 0)
                    {
                        double trailTicks = trailDist / TickSize;
                        trailText = string.Format("{0:F2} (Countdown: {1:F2} pts / {2} ticks)", signalTrailingPrice, trailDist, Math.Round(trailTicks));
                    }
                    else
                    {
                        trailText = string.Format("{0:F2} (ACTIVE 📈)", signalTrailingPrice);
                    }
                }

                targetInfo = string.Format(
                    "--------------------------------------------------\n" +
                    "🎯 TARGET & RISK COUNTDOWNS:\n" +
                    "• Take Profit (TP): {0}\n" +
                    "• Stop Loss (SL)  : {1}\n" +
                    "• Breakeven Trgr  : {2}\n" +
                    "• Trailing Trgr   : {3}\n",
                    tpText, slText, beText, trailText
                );
            }

            // Antigravity v2 Brain Panel — appended after existing status/position info.
            // Populated by BRAIN<TAB>json messages from Node after every closed bar.
            string brainSection = BuildBrainPanelSection();

            string labelText = string.Format(
                "🚀 ANTIGRAVITY v2 BRIDGE\n" +
                "==================================================\n" +
                "• Status: {0}\n" +
                "• Timeframe: {1}-Minute Chart (Execution Mode)\n" +
                "• Active Position: {2}\n" +
                "{3}" +
                "{4}",
                statusText,
                BarsPeriod.Value,
                posInfo,
                targetInfo,
                brainSection
            );

            // ── Populate the v2 structured Brain Panel cells (visual rich version) ──
            if (brainRows != null)
            {
                ChartControl.Dispatcher.InvokeAsync(new Action(() => {
                    try
                    {
                        // Header status
                        if (brainHeaderStatus != null) {
                            brainHeaderStatus.Text = isConnected
                                ? (isTradingEnabled ? "● LIVE" : "● HALTED")
                                : "● DISCONNECTED";
                            brainHeaderStatus.Foreground = isConnected
                                ? (isTradingEnabled ? COL_GREEN : COL_AMBER)
                                : COL_RED;
                        }
                        // Signal row
                        bool isLong  = brainAction == "BUY";
                        bool isShort = brainAction == "SELL";
                        if (brainSignalArrow != null) {
                            brainSignalArrow.Text = isLong ? "▲" : (isShort ? "▼" : "—");
                            brainSignalArrow.Foreground = isLong ? COL_GREEN : (isShort ? COL_RED : COL_MUTED);
                        }
                        if (brainSignalText != null) {
                            brainSignalText.Text = isLong ? "BUY  (LONG)"
                                                : isShort ? "SELL (SHORT)"
                                                : (brainRegime == "CHOP" ? "CHOP — stand down" : "WAIT — below threshold");
                            brainSignalText.Foreground = isLong ? COL_GREEN : (isShort ? COL_RED : COL_MUTED);
                        }
                        // Long probability bar — show "—" only when threshold = 0 (no specialist
                        // deployed for that direction). CHOP has its own CHOP_long/CHOP_short
                        // specialists that CAN fire BUY/SELL — never suppress probs based on regime.
                        bool hasLongData  = brainLongTh  > 0;
                        bool hasShortData = brainShortTh > 0;
                        if (brainLongProbText != null) {
                            if (hasLongData) {
                                brainLongProbText.Text = brainLongProb.ToString("F2");
                                bool longHit = brainLongProb >= brainLongTh;
                                brainLongProbText.Foreground = longHit ? COL_GREEN : COL_VAL;
                            } else {
                                brainLongProbText.Text = "—";
                                brainLongProbText.Foreground = COL_MUTED;
                            }
                        }
                        if (brainLongProbBar != null) {
                            double pct = hasLongData ? Math.Max(0, Math.Min(1, brainLongProb)) : 0;
                            brainLongProbBar.Width = pct * PROB_BAR_WIDTH;
                        }
                        if (brainLongProbThMark != null) {
                            if (hasLongData) {
                                double thFrac = Math.Max(0, Math.Min(1, brainLongTh));
                                brainLongProbThMark.Margin = new Thickness(thFrac * PROB_BAR_WIDTH, -2, 0, -2);
                                brainLongProbThMark.Visibility = Visibility.Visible;
                            } else {
                                brainLongProbThMark.Visibility = Visibility.Collapsed;
                            }
                        }
                        // Short probability bar
                        if (brainShortProbText != null) {
                            if (hasShortData) {
                                brainShortProbText.Text = brainShortProb.ToString("F2");
                                bool shortHit = brainShortProb >= brainShortTh;
                                brainShortProbText.Foreground = shortHit ? COL_RED : COL_VAL;
                            } else {
                                brainShortProbText.Text = "—";
                                brainShortProbText.Foreground = COL_MUTED;
                            }
                        }
                        if (brainShortProbBar != null) {
                            double pct = hasShortData ? Math.Max(0, Math.Min(1, brainShortProb)) : 0;
                            brainShortProbBar.Width = pct * PROB_BAR_WIDTH;
                        }
                        if (brainShortProbThMark != null) {
                            if (hasShortData) {
                                double thFrac = Math.Max(0, Math.Min(1, brainShortTh));
                                brainShortProbThMark.Margin = new Thickness(thFrac * PROB_BAR_WIDTH, -2, 0, -2);
                                brainShortProbThMark.Visibility = Visibility.Visible;
                            } else {
                                brainShortProbThMark.Visibility = Visibility.Collapsed;
                            }
                        }
                        // Regime / Session
                        if (brainRegimeText != null) {
                            brainRegimeText.Text = string.IsNullOrEmpty(brainRegime) ? "—" : brainRegime;
                            brainRegimeText.Foreground = brainRegime == "TREND_UP"      ? COL_GREEN
                                                       : brainRegime == "TREND_DOWN"    ? COL_RED
                                                       : brainRegime == "VOL_EXPANSION" ? COL_LABEL
                                                       : COL_MUTED;
                        }
                        if (brainSessionText != null) {
                            brainSessionText.Text = "session: " + (string.IsNullOrEmpty(brainSession) ? "—" : brainSession);
                        }
                        // Specialist — show direction + watching/active status so user can read state at a glance
                        if (brainSpecText != null) {
                            string baseSpec = string.IsNullOrEmpty(brainSpecialist) ? "" : brainSpecialist;
                            string specDisplay;
                            if (brainAction == "BUY" && baseSpec.Length > 0 && baseSpec != "—") {
                                specDisplay = baseSpec + "  ↑ ACTIVE";
                                brainSpecText.Foreground = COL_GREEN;
                            } else if (brainAction == "SELL" && baseSpec.Length > 0 && baseSpec != "—") {
                                specDisplay = baseSpec + "  ↓ ACTIVE";
                                brainSpecText.Foreground = COL_RED;
                            } else if (baseSpec.Length == 0 || baseSpec == "—") {
                                // No specialist at all (no model deployed for this regime/session)
                                specDisplay = "no specialist — monitoring";
                                brainSpecText.Foreground = COL_MUTED;
                            } else {
                                // WAIT — show which directions are armed based on deployed thresholds
                                string dirs = (hasLongData && hasShortData) ? " ↑↓"
                                            : hasLongData  ? " ↑"
                                            : hasShortData ? " ↓" : "";
                                specDisplay = baseSpec + dirs + "  watching";
                                brainSpecText.Foreground = COL_VAL;
                            }
                            brainSpecText.Text = specDisplay;
                        }
                        // Position + P&L (from NT8 directly, not from brain JSON)
                        if (Position != null && Position.MarketPosition != MarketPosition.Flat) {
                            bool posLong = Position.MarketPosition == MarketPosition.Long;
                            if (brainPositionText != null) {
                                brainPositionText.Text = (posLong ? "LONG  × " : "SHORT × ") + Position.Quantity + " @ " + Position.AveragePrice.ToString("F2");
                                brainPositionText.Foreground = posLong ? COL_GREEN : COL_RED;
                            }
                            double pnl = Position.GetUnrealizedProfitLoss(PerformanceUnit.Currency, Close[0]);
                            if (brainPnLText != null) {
                                brainPnLText.Text = (pnl >= 0 ? "+$" : "-$") + Math.Abs(pnl).ToString("F2");
                                brainPnLText.Foreground = pnl >= 0 ? COL_GREEN : COL_RED;
                            }
                            // BE / Trail countdowns
                            if (brainBeText != null) {
                                if (signalBreakevenPrice > 0.01) {
                                    double beDist = posLong ? (signalBreakevenPrice - Close[0]) : (Close[0] - signalBreakevenPrice);
                                    if (beDist > 0) {
                                        double beTicks = Math.Abs(beDist) / TickSize;
                                        brainBeText.Text = string.Format("{0:F0}t ({1:F2} pts) — armed at {2:F2}", beTicks, beDist, signalBreakevenPrice);
                                        brainBeText.Foreground = COL_VAL;
                                    } else {
                                        brainBeText.Text = "🛡️ ACTIVE — stop at " + signalBreakevenPrice.ToString("F2");
                                        brainBeText.Foreground = COL_GREEN;
                                    }
                                } else { brainBeText.Text = "—"; brainBeText.Foreground = COL_MUTED; }
                            }
                            if (brainTrailText != null) {
                                if (signalTrailingPrice > 0.01) {
                                    double trDist = posLong ? (signalTrailingPrice - Close[0]) : (Close[0] - signalTrailingPrice);
                                    if (trDist > 0) {
                                        double trTicks = Math.Abs(trDist) / TickSize;
                                        brainTrailText.Text = string.Format("{0:F0}t ({1:F2} pts) — starts at {2:F2}", trTicks, trDist, signalTrailingPrice);
                                        brainTrailText.Foreground = COL_VAL;
                                    } else {
                                        brainTrailText.Text = "📈 ACTIVE — chasing price";
                                        brainTrailText.Foreground = COL_GREEN;
                                    }
                                } else { brainTrailText.Text = "—"; brainTrailText.Foreground = COL_MUTED; }
                            }
                        } else {
                            if (brainPositionText != null) { brainPositionText.Text = "FLAT"; brainPositionText.Foreground = COL_MUTED; }
                            if (brainPnLText != null)      { brainPnLText.Text = "—"; brainPnLText.Foreground = COL_MUTED; }
                            if (brainBeText != null)       { brainBeText.Text = "—"; brainBeText.Foreground = COL_MUTED; }
                            if (brainTrailText != null)    { brainTrailText.Text = "—"; brainTrailText.Foreground = COL_MUTED; }
                        }
                        // ATR + Trades
                        if (brainAtrText != null)    brainAtrText.Text    = brainAtr > 0 ? brainAtr.ToString("F2") : "—";
                        if (brainTradesText != null) brainTradesText.Text = todayTrades.ToString();
                        // Mode + Exits
                        if (brainModeText != null) {
                            string gateTag = (brainGate == "gate2")
                                ? (" · G2" + (string.IsNullOrEmpty(brainPattern) ? "" : ":" + brainPattern))
                                : " · G1";
                            string eodTag = eodHaltApplied ? " · EOD HALT" : "";
                            brainModeText.Text = brainContractMode + " · " + brainTradingMode.ToUpper() + gateTag + eodTag;
                            brainModeText.Foreground = eodHaltApplied ? COL_RED
                                                     : brainTradingMode == "live" ? COL_RED : COL_AMBER;
                        }
                        if (brainExitsText != null) {
                            brainExitsText.Text = "Exits: " + brainExitMode + (brainExitMode == "FIXED" ? "  (override active)" : "  (ATR-dynamic)");
                            brainExitsText.Foreground = brainExitMode == "FIXED" ? COL_AMBER : COL_VAL;
                        }
                        // Bar→Bot feed health indicator
                        if (brainBarSentText != null) {
                            if (_lastBarSentTime == DateTime.MinValue) {
                                brainBarSentText.Text       = "● waiting for first bar…";
                                brainBarSentText.Foreground = COL_MUTED;
                            } else {
                                double secAgo = (DateTime.Now - _lastBarSentTime).TotalSeconds;
                                string timeStr = _lastBarSentTime.ToString("HH:mm:ss");
                                string countStr = " (#" + _barsSentTotal + ")";
                                if (secAgo <= 90) {
                                    // Live — bar within last 90 seconds
                                    brainBarSentText.Text       = "● " + timeStr + countStr;
                                    brainBarSentText.Foreground = COL_GREEN;
                                } else if (secAgo <= 600) {
                                    // Slightly stale — 1.5–10 min
                                    int minAgo = (int)(secAgo / 60);
                                    brainBarSentText.Text       = "◉ " + timeStr + "  (" + minAgo + "m ago)" + countStr;
                                    brainBarSentText.Foreground = COL_AMBER;
                                } else {
                                    // Stale — over 10 min, data feed may be dead
                                    int minAgo = (int)(secAgo / 60);
                                    brainBarSentText.Text       = "✕ STALE  " + timeStr + "  (" + minAgo + "m ago)";
                                    brainBarSentText.Foreground = COL_RED;
                                }
                            }
                        }
                        // Border glow color — matches old behavior: green when in profit,
                        // red when losing, cyan when flat & connected, orange when halted,
                        // red when disconnected.
                        if (wpfPanel != null) {
                            var _glow = new SolidColorBrush(borderGlowColor);
                            _glow.Freeze();
                            wpfPanel.BorderBrush = _glow;
                        }
                    } catch (Exception ex) {
                        Print("Brain panel update error: " + ex.Message);
                    }
                }));
            }
        }

        // ─────────────────────────────────────────────────────────────────
        // Antigravity v2 Brain Panel — on-chart overlay block
        // Renders model state (regime + specialist + probabilities + features)
        // from the BRAIN_STATE messages Node pushes after each bar close.
        // ─────────────────────────────────────────────────────────────────
        private string BuildBrainPanelSection()
        {
            if (brainLastUpdate == DateTime.MinValue)
            {
                return
                    "--------------------------------------------------\n" +
                    "🧠 ANTIGRAVITY v2 BRAIN  (awaiting first bar push)\n";
            }

            // CHOP has CHOP_long/CHOP_short specialists — never suppress probs by regime
            bool txtHasLong  = brainLongTh  > 0;
            bool txtHasShort = brainShortTh > 0;

            string verdict;
            if      (brainAction == "BUY")  verdict = "▲ FIRE LONG";
            else if (brainAction == "SELL") verdict = "▼ FIRE SHORT";
            else if (txtHasLong || txtHasShort) verdict = "WAIT — below threshold";
            else                            verdict = "WAIT — awaiting specialist";

            string longHit  = (txtHasLong  && brainLongProb  >= brainLongTh)  ? " ✓" : "";
            string shortHit = (txtHasShort && brainShortProb >= brainShortTh) ? " ✓" : "";

            // Specialist line — include direction + status
            string specBase = string.IsNullOrEmpty(brainSpecialist) ? "—" : brainSpecialist;
            string specLine;
            if (brainAction == "BUY"  && specBase != "—") specLine = specBase + " ↑ ACTIVE";
            else if (brainAction == "SELL" && specBase != "—") specLine = specBase + " ↓ ACTIVE";
            else if (specBase == "—") specLine = "no specialist — monitoring";
            else {
                string dirs = (txtHasLong && txtHasShort) ? " ↑↓" : txtHasLong ? " ↑" : txtHasShort ? " ↓" : "";
                specLine = specBase + dirs + " watching";
            }

            // Prob lines — show "—" when no specialist is deployed for that direction
            string longProbLine  = txtHasLong
                ? string.Format(System.Globalization.CultureInfo.InvariantCulture,
                    "prob {0:F2} / th {1:F2}{2}", brainLongProb,  brainLongTh,  longHit)
                : "prob — (no specialist)";
            string shortProbLine = txtHasShort
                ? string.Format(System.Globalization.CultureInfo.InvariantCulture,
                    "prob {0:F2} / th {1:F2}{2}", brainShortProb, brainShortTh, shortHit)
                : "prob — (no specialist)";

            string gateStr  = brainGate == "gate2"
                ? ("Gate2" + (string.IsNullOrEmpty(brainPattern) ? "" : ":" + brainPattern))
                : "Gate1";
            string eodStr   = eodHaltApplied ? "  ⚠ EOD HALT" : "";
            string modeLine = string.Format("Contract: {0}   |   Trading: {1}   |   Exits: {2}   |   {3}{4}",
                brainContractMode, brainTradingMode.ToUpper(), brainExitMode, gateStr, eodStr);

            return string.Format(
                "--------------------------------------------------\n" +
                "🧠 ANTIGRAVITY v2 BRAIN   (last: {0:HH:mm:ss})\n" +
                "• Close {1:F2}  ATR {2:F2}\n" +
                "• Regime: {3}   Session: {4}\n" +
                "• Verdict: {5}\n" +
                "• Specialist: {6}\n" +
                "• LONG  {7}\n" +
                "• SHORT {8}\n" +
                "• Features: {9}\n" +
                "• {10}\n",
                brainLastUpdate.ToLocalTime(),
                brainClose, brainAtr,
                brainRegime, brainSession,
                verdict,
                specLine,
                longProbLine,
                shortProbLine,
                string.IsNullOrEmpty(brainFeatures) ? "—" : brainFeatures,
                modeLine
            );
        }

        // Manual JSON value extractor — NT8 ships without Newtonsoft.Json in older
        // distros, and adding refs in a strategy file is fragile. The payload is
        // well-controlled (we wrote both ends), so simple substring extraction is
        // robust enough. Returns null if the key isn't found.
        private string JsonStr(string json, string key)
        {
            string needle = "\"" + key + "\":";
            int i = json.IndexOf(needle);
            if (i < 0) return null;
            int p = i + needle.Length;
            while (p < json.Length && (json[p] == ' ' || json[p] == '\t')) p++;
            if (p >= json.Length) return null;
            char first = json[p];
            if (first == '"')
            {
                int end = json.IndexOf('"', p + 1);
                if (end < 0) return null;
                return json.Substring(p + 1, end - p - 1);
            }
            if (first == 'n' && json.Substring(p).StartsWith("null")) return null;
            // Numeric or boolean — read until comma or close-brace
            int q = p;
            while (q < json.Length && json[q] != ',' && json[q] != '}' && json[q] != '\n') q++;
            return json.Substring(p, q - p).Trim();
        }

        private double JsonNum(string json, string key, double fallback)
        {
            string s = JsonStr(json, key);
            if (s == null) return fallback;
            double v;
            return double.TryParse(s, System.Globalization.NumberStyles.Any,
                System.Globalization.CultureInfo.InvariantCulture, out v) ? v : fallback;
        }

        private void HandleBrainState(string json)
        {
            try
            {
                // DEBUG — fires unconditionally so we know packet arrived at this chart
                Print("[BRAIN] packet received, len=" + json.Length + " — chart=" + Instrument.FullName);
                // ── Family-based symbol filter ─────────────────────────────────
                // Node broadcasts BRAIN packets to ALL connected NT8 clients
                // (one socket per chart). Filter so each chart only renders
                // its own family. The packet's `family` field is always the
                // MINI sym ("NQ=F"), but THIS chart may be on micro ("MNQ=F").
                // Normalize BOTH sides to the base family (strip leading M)
                // before comparing — fixes brain panel never updating on
                // micro charts (bug found 2026-05-26).
                string packetFamily = JsonStr(json, "family");
                if (string.IsNullOrEmpty(packetFamily)) packetFamily = JsonStr(json, "symbol");
                if (!string.IsNullOrEmpty(packetFamily))
                {
                    string mySym = ResolveSymbolCode();   // e.g. "NQ=F" or "MNQ=F"
                    // Inline strip — no lambda (NT8 compiler can be finicky with Func inside try)
                    string pNorm = packetFamily;
                    if (pNorm.StartsWith("MNQ") || pNorm.StartsWith("MES") ||
                        pNorm.StartsWith("MCL") || pNorm.StartsWith("MGC"))
                        pNorm = pNorm.Substring(1);
                    string mNorm = mySym;
                    if (mNorm.StartsWith("MNQ") || mNorm.StartsWith("MES") ||
                        mNorm.StartsWith("MCL") || mNorm.StartsWith("MGC"))
                        mNorm = mNorm.Substring(1);
                    // DEBUG — fires on every packet so we can see filter decisions
                    Print("[BRAIN-FILTER] packet=" + packetFamily + " norm=" + pNorm +
                          " | chart=" + mySym + " norm=" + mNorm +
                          " → " + (pNorm == mNorm ? "ACCEPT" : "REJECT"));
                    if (pNorm != mNorm)
                    {
                        return; // Different family — ignore.
                    }
                }

                brainRegime       = JsonStr(json, "regime")        ?? "—";
                brainSession      = JsonStr(json, "session")       ?? "—";
                brainAction       = JsonStr(json, "action")        ?? "FLAT";
                brainSpecialist   = JsonStr(json, "specialist")    ?? "—";
                brainContractMode = JsonStr(json, "contractMode")  ?? "MINI";
                brainTradingMode  = JsonStr(json, "tradingMode")   ?? "paper";
                brainExitMode     = JsonStr(json, "exitMode")      ?? "ATR";
                brainGate         = JsonStr(json, "gate")          ?? "gate1";
                brainPattern      = JsonStr(json, "pattern")       ?? "";
                brainClose        = JsonNum(json, "close", 0);
                brainAtr          = JsonNum(json, "atr",   0);
                brainLongProb     = JsonNum(json, "longProb",  0);
                brainShortProb    = JsonNum(json, "shortProb", 0);
                brainLongTh       = JsonNum(json, "longTh",  0);
                brainShortTh      = JsonNum(json, "shortTh", 0);
                // Compact top-feature string for display
                double rsi  = JsonNum(json, "rsi",  double.NaN);
                double macd = JsonNum(json, "macd_hist", double.NaN);
                double adx  = JsonNum(json, "adx",  double.NaN);
                double bbz  = JsonNum(json, "bb_z", double.NaN);
                System.Collections.Generic.List<string> bits = new System.Collections.Generic.List<string>();
                if (!double.IsNaN(rsi))  bits.Add(string.Format("rsi={0:F1}", rsi));
                if (!double.IsNaN(macd)) bits.Add(string.Format("macd_h={0:+0.00;-0.00;0.00}", macd));
                if (!double.IsNaN(adx))  bits.Add(string.Format("adx={0:F1}", adx));
                if (!double.IsNaN(bbz))  bits.Add(string.Format("bb_z={0:+0.00;-0.00;0.00}", bbz));
                brainFeatures = string.Join("  ", bits);
                brainLastUpdate = DateTime.UtcNow;
                UpdateChartOverlay();
            }
            catch (Exception ex)
            {
                Print("AntigravityBridge: HandleBrainState parse error: " + ex.Message);
            }
        }

        // Signal Parser and Order Submitter
        private void ExecuteSignal(string signal)
        {
            try
            {
                // BRAIN packet — TAB-delimited because payload is JSON with commas
                // Format: BRAIN\t{"regime":"...","longProb":0.34,...}
                if (signal.StartsWith("BRAIN\t"))
                {
                    HandleBrainState(signal.Substring(6));
                    return;
                }

                // Format: ACTION,SYMBOL,QTY,PRICE,SL,TP,STRATEGY
                // E.g., BUY,NQ=F,2,18500.50,18400.00,18700.00,Fair Value Gap
                // E.g., CLOSE,NQ=F
                string[] parts = signal.Split(',');
                if (parts.Length == 0) return;

                string action = parts[0].ToUpper();
                
                // PARAMS packet handling
                if (action == "PARAMS")
                {
                    string sym = parts[1];
                    // Use family-based matching (same as BUY/SELL) to correctly
                    // accept PARAMS on micro charts (MNQ=F) when signal says NQ=F.
                    string pSigFamily = sym.Replace("=F", "");
                    if (pSigFamily.Length > 2 && pSigFamily.StartsWith("M")) pSigFamily = pSigFamily.Substring(1);
                    string pChartName = Instrument.FullName;
                    string pChartFam  = pChartName.StartsWith("MNQ") || pChartName.StartsWith("NQ") ? "NQ"
                                      : pChartName.StartsWith("MES") || pChartName.StartsWith("ES") ? "ES"
                                      : pChartName.StartsWith("MCL") || pChartName.StartsWith("CL") ? "CL"
                                      : pChartName.StartsWith("MGC") || pChartName.StartsWith("GC") ? "GC" : "";
                    if (pChartFam == pSigFamily)
                    {
                        string emaFast = parts[2];
                        string emaSlow = parts[3];
                        string bbStdDev = parts[4];
                        string rsiOversold = parts[5];
                        string rsiOverbought = parts[6];

                        // Parse parameters for real-time dynamic plot rendering!
                        int.TryParse(emaFast, out parsedEmaFast);
                        int.TryParse(emaSlow, out parsedEmaSlow);
                        double.TryParse(bbStdDev, out parsedBbDev);

                        activeParamsText = string.Format(
                            "• RTH EMAs: Fast {0} / Slow {1}\n" +
                            "• ETH Mean Reversion: BB Dev {2} | RSI {3}-{4}",
                            emaFast, emaSlow, bbStdDev, rsiOversold, rsiOverbought
                        );
                        UpdateChartOverlay();
                    }
                    return;
                }

                // STATUS packet handling
                if (action == "STATUS")
                {
                    string sym = parts[1];
                    // Use family-based matching (same fix as PARAMS above)
                    string sSigFamily = sym.Replace("=F", "");
                    if (sSigFamily.Length > 2 && sSigFamily.StartsWith("M")) sSigFamily = sSigFamily.Substring(1);
                    string sChartName = Instrument.FullName;
                    string sChartFam  = sChartName.StartsWith("MNQ") || sChartName.StartsWith("NQ") ? "NQ"
                                      : sChartName.StartsWith("MES") || sChartName.StartsWith("ES") ? "ES"
                                      : sChartName.StartsWith("MCL") || sChartName.StartsWith("CL") ? "CL"
                                      : sChartName.StartsWith("MGC") || sChartName.StartsWith("GC") ? "GC" : "";
                    if (sChartFam == sSigFamily)
                    {
                        int enabledVal = 1;
                        int.TryParse(parts[2], out enabledVal);
                        isTradingEnabled = (enabledVal == 1);
                        Print("AntigravityBridge: Received STATUS update. Trading enabled state: " + isTradingEnabled);
                        
                        if (!isTradingEnabled)
                        {
                            Print("AntigravityBridge: Toggled OFF from Dashboard! Force flattening active position...");
                            
                            // Cancel all active pending orders first on this instrument
                            if (Account != null)
                            {
                                foreach (var o in Account.Orders)
                                {
                                    if (o != null && o.Instrument != null && o.Instrument.FullName == Instrument.FullName &&
                                        (o.OrderState == OrderState.Working || o.OrderState == OrderState.Accepted || o.OrderState == OrderState.Submitted))
                                    {
                                        try { Account.Cancel(new[] { o }); }
                                        catch (Exception ex) { Print("Cancel order error: " + ex.Message); }
                                    }
                                }
                            }
                            
                            // Exit open positions
                            if (Position.MarketPosition == MarketPosition.Long)
                            {
                                ExitLong();
                            }
                            else if (Position.MarketPosition == MarketPosition.Short)
                            {
                                ExitShort();
                            }
                        }
                        UpdateChartOverlay();
                    }
                    return;
                }

                string symbol = parts[1];

                // Check welcome handshake
                if (action == "CONNECTED")
                {
                    lastSignal = "Socket Handshake Complete";
                    lastStrategy = "Monitoring Regimes";
                    UpdateChartOverlay();
                    return;
                }

                // ─── FAMILY-BASED MATCHING ─────────────────────────────────────
                // Accept signals where the family (NQ/ES/CL/GC) matches the chart
                // instrument, regardless of MINI/MICRO designation. If signal type
                // differs from chart type (e.g., MNQ signal on NQ chart), the qty
                // will be auto-scaled later. Eliminates symbol-mismatch silent
                // rejections when bot's MINI/MICRO mode doesn't match chart.
                //
                // Signal sym examples: "NQ=F", "MNQ=F", "ES=F", "MES=F"
                // Chart FullName examples: "NQ 12-26", "MNQ 12-26", "ES 12-26", "MES 12-26"
                string sigFamily = symbol.Replace("=F", "");
                if (sigFamily.StartsWith("M") && sigFamily.Length > 2)
                    sigFamily = sigFamily.Substring(1);   // MNQ → NQ
                string chartFamily = "";
                string chartName = Instrument.FullName;
                if (chartName.StartsWith("MNQ") || chartName.StartsWith("NQ")) chartFamily = "NQ";
                else if (chartName.StartsWith("MES") || chartName.StartsWith("ES")) chartFamily = "ES";
                else if (chartName.StartsWith("MCL") || chartName.StartsWith("CL")) chartFamily = "CL";
                else if (chartName.StartsWith("MGC") || chartName.StartsWith("GC")) chartFamily = "GC";

                if (chartFamily != sigFamily)
                {
                    Print("AntigravityBridge: Signal ignored. Chart family=" + chartFamily +
                          " but signal family=" + sigFamily + " (chart=" + chartName + ", sig=" + symbol + ")");
                    return;
                }

                // Determine if chart is MICRO (M-prefix) vs MINI for qty scaling later
                bool chartIsMicro = chartName.StartsWith("M");
                bool signalIsMicro = symbol.StartsWith("M");

                if (action == "CLOSE")
                {
                    Print("AntigravityBridge: CLOSE received — deferring ExitLong/ExitShort to OnBarUpdate.");
                    lastSignal   = "CLOSE (FLATTEN) Order Received";
                    lastStrategy = "Dashboard Forced Close / Halted";

                    // Cancel pending bracket orders immediately (Account.Cancel is thread-safe).
                    if (Account != null)
                    {
                        foreach (var o in Account.Orders)
                        {
                            if (o != null && o.Instrument != null &&
                                o.Instrument.FullName == Instrument.FullName &&
                                (o.OrderState == OrderState.Working ||
                                 o.OrderState == OrderState.Accepted ||
                                 o.OrderState == OrderState.Submitted))
                            {
                                try { Account.Cancel(new[] { o }); }
                                catch (Exception ex) { Print("Cancel order error: " + ex.Message); }
                            }
                        }
                    }

                    // Defer ExitLong/ExitShort to OnBarUpdate — those calls must
                    // run on NT8's strategy thread, not the WPF dispatcher.
                    _pendingClose = true;
                    UpdateChartOverlay();
                }
                else if (action == "BUY" || action == "SELL")
                {
                    int rawQty = int.Parse(parts[2]);

                    // ─── AUTO QTY SCALING ─────────────────────────────────────
                    int qty = rawQty;
                    if (signalIsMicro && !chartIsMicro)
                    {
                        qty = Math.Max(1, (int)Math.Round(rawQty / 10.0));
                        Print(string.Format("AntigravityBridge: QTY SCALED — signal {0} micros → {1} mini(s) (chart={2})",
                              rawQty, qty, chartName));
                    }
                    else if (!signalIsMicro && chartIsMicro)
                    {
                        qty = rawQty * 10;
                        Print(string.Format("AntigravityBridge: QTY SCALED — signal {0} mini(s) → {1} micros (chart={2})",
                              rawQty, qty, chartName));
                    }

                    double entryPrice = double.Parse(parts[3]);
                    double stopLoss   = double.Parse(parts[4]);
                    double takeProfit = double.Parse(parts[5]);
                    string strat      = parts.Length >= 7 ? parts[6] : "Confluence Trigger";
                    double bePrice    = 0; if (parts.Length >= 8) double.TryParse(parts[7], out bePrice);
                    double trailPrice = 0; if (parts.Length >= 9) double.TryParse(parts[8], out trailPrice);

                    lastSignal = string.Format("{0} {1} Contract(s) @ {2}", action, qty, entryPrice.ToString("F2"));

                    if (!isTradingEnabled)
                    {
                        Print("AntigravityBridge: " + action + " ignored — trading is suspended (OFF).");
                        return;
                    }
                    if (eodHaltApplied)
                    {
                        Print("AntigravityBridge: " + action + " ignored — EOD halt active (after 4:45 PM ET).");
                        return;
                    }
                    if (_entryInFlight || Position.MarketPosition != MarketPosition.Flat)
                    {
                        Print(string.Format("AntigravityBridge: {0} ignored — {1}",
                            action,
                            _entryInFlight ? "entry already in flight (fill pending)" : "already in position: " + Position.MarketPosition));
                        return;
                    }

                    // Store signal — EnterLong/EnterShort MUST be called from OnBarUpdate
                    // (V6 pattern).  The dispatcher thread cannot submit entries directly;
                    // doing so causes NT8 to silently drop the order with no error.
                    _entryInFlight     = true;   // arm — cleared by OnPositionUpdate on fill
                    _pendingAction     = action;
                    _pendingQty        = qty;
                    _pendingEntryPrice = entryPrice;
                    _pendingSl         = stopLoss;
                    _pendingTp         = takeProfit;
                    _pendingStrategy   = strat;
                    _pendingBe         = bePrice;
                    _pendingTrail      = trailPrice;

                    Print(string.Format("AntigravityBridge: {0} queued → will fire on next OnBarUpdate. Qty={1} entry={2:F2} SL={3:F2} TP={4:F2}",
                          action, qty, entryPrice, stopLoss, takeProfit));
                    UpdateChartOverlay();
                }
            }
            catch (Exception ex)
            {
                Print("AntigravityBridge: Execution error: " + ex.Message);
            }
        }

        #region Properties
        [NinjaScriptProperty]
        [System.ComponentModel.Category("Connection Settings")]
        [System.ComponentModel.DisplayName("Mac OS IP Address")]
        public string ServerIP
        {
            get { return serverIP; }
            set { serverIP = value; }
        }

        [NinjaScriptProperty]
        [System.ComponentModel.Category("Connection Settings")]
        [System.ComponentModel.DisplayName("Port")]
        public int ServerPort
        {
            get { return serverPort; }
            set { serverPort = value; }
        }
        #endregion
    }
}
