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
        private TextBlock wpfTextBlock = null;
        private Canvas wpfCanvas = null;
        private Grid chartGrid = null;
        private string activeParamsText = "• RTH EMAs: Default (9/21)\n• ETH Regimes: Default (BB 2.0, RSI 30/70)";

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

        protected override void OnStateChange()
        {
            if (State == State.SetDefaults)
            {
                Description                                  = "V1 Antigravity C# Socket Execution Bridge for NinjaTrader 8";
                Name                                         = "AntigravityBotBridge";
                Calculate                                    = Calculate.OnEachTick;
                EntriesPerDirection                          = 1;
                EntryHandling                                = EntryHandling.AllEntries;
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

        // Resolves Yahoo-style symbol code from current chart instrument
        private string ResolveSymbolCode()
        {
            string name = Instrument.FullName.ToUpper();
            if (name.Contains("NQ")) return "NQ=F";
            if (name.Contains("ES")) return "ES=F";
            if (name.Contains("CL")) return "CL=F";
            if (name.Contains("GC")) return "GC=F";
            return "NQ=F";
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

            // Stage 2: Trailing — once trail trigger hit, advance SL at currentAtr * 1.0 behind price
            if (beApplied)
            {
                bool trailHit = isLong ? px >= signalTrailingPrice : px <= signalTrailingPrice;
                if (trailHit)
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
                        }
                        catch (Exception ex) { Print("Trail move error: " + ex.Message); }
                    }
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

                        // Transmit the active account for this symbol assigned on the chart to the Node.js server
                        string symbol = "NQ=F";
                        string name = Instrument.FullName.ToUpper();
                        if (name.Contains("NQ")) symbol = "NQ=F";
                        else if (name.Contains("ES")) symbol = "ES=F";
                        else if (name.Contains("CL")) symbol = "CL=F";
                        else if (name.Contains("GC")) symbol = "GC=F";

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
                    byte[] buffer = new byte[1024];
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
                    wpfPanel.Background = new SolidColorBrush(Color.FromArgb(220, 10, 12, 16)); // Glassy dark
                    wpfPanel.BorderBrush = new SolidColorBrush(Color.FromRgb(33, 150, 243)); // Dynamic color
                    wpfPanel.BorderThickness = new Thickness(1.5);
                    wpfPanel.CornerRadius = new CornerRadius(12);
                    wpfPanel.Width = 425;
                    wpfPanel.Height = 355;
                    wpfPanel.Padding = new Thickness(16);
                    wpfPanel.Cursor = Cursors.SizeAll;

                    // Position it initially in top-left offset
                    Canvas.SetLeft(wpfPanel, 40);
                    Canvas.SetTop(wpfPanel, 80);

                    // 3. Text block inside border
                    wpfTextBlock = new TextBlock();
                    wpfTextBlock.FontFamily = new FontFamily("Consolas");
                    wpfTextBlock.FontSize = 13;
                    wpfTextBlock.Foreground = Brushes.White;
                    wpfTextBlock.TextWrapping = TextWrapping.Wrap;
                    wpfPanel.Child = wpfTextBlock;

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
                            double newTop = startTop + (curPos.Y - dragStart.Y);
                            
                            // Bounds checks
                            newLeft = Math.Max(0, Math.Min(wpfCanvas.ActualWidth - wpfPanel.Width, newLeft));
                            newTop = Math.Max(0, Math.Min(wpfCanvas.ActualHeight - wpfPanel.Height, newTop));
                            
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
                
                // Set border color based on P&L (Neon Green for profit, Deep Hot Pink for loss)
                borderGlowColor = pnl >= 0 ? Color.FromRgb(57, 255, 20) : Color.FromRgb(255, 0, 122);
                
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

            string labelText = string.Format(
                "🚀 ANTIGRAVITY V1 SMART BOT BRIDGE\n" +
                "==================================================\n" +
                "• Status: {0}\n" +
                "• Timeframe: {1}-Minute Chart (Execution Mode)\n" +
                "• Active Position: {2}\n" +
                "{3}" +
                "--------------------------------------------------\n" +
                "📊 ACTIVE MACHINE LEARNING PARAMETERS:\n" +
                "{4}",
                statusText,
                BarsPeriod.Value,
                posInfo,
                targetInfo,
                activeParamsText
            );

            if (wpfTextBlock != null)
            {
                ChartControl.Dispatcher.InvokeAsync(new Action(() => {
                    wpfTextBlock.Text = labelText;
                    
                    // Dynamically set border color
                    if (wpfPanel != null)
                    {
                        wpfPanel.BorderBrush = new SolidColorBrush(borderGlowColor);
                    }
                }));
            }
        }

        // Signal Parser and Order Submitter
        private void ExecuteSignal(string signal)
        {
            try
            {
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
                    // Verify if this is the active chart instrument
                    if (Instrument.FullName.Contains(sym.Replace("=F", "")))
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
                    if (Instrument.FullName.Contains(sym.Replace("=F", "")))
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

                // Ensure the chart matches the incoming symbol
                if (!Instrument.FullName.Contains(symbol.Replace("=F", "")))
                {
                    Print("AntigravityBridge: Signal ignored. Active chart instrument does not match signal: " + symbol);
                    return;
                }

                if (action == "CLOSE")
                {
                    Print("AntigravityBridge: Flattening active positions for " + symbol);
                    
                    lastSignal = "CLOSE (FLATTEN) Order Received";
                    lastStrategy = "Dashboard Forced Close / Halted";
                    UpdateChartOverlay();

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
                else if (action == "BUY" || action == "SELL")
                {
                    int qty = int.Parse(parts[2]);
                    double entryPrice = double.Parse(parts[3]);
                    double stopLoss = double.Parse(parts[4]);
                    double takeProfit = double.Parse(parts[5]);
                    
                    signalStopLoss = stopLoss;
                    signalTakeProfit = takeProfit;
                    if (parts.Length >= 8)
                    {
                        double.TryParse(parts[7], out signalBreakevenPrice);
                    }
                    if (parts.Length >= 9)
                    {
                        double.TryParse(parts[8], out signalTrailingPrice);
                    }
                    
                    if (parts.Length >= 7)
                    {
                        lastStrategy = parts[6];
                    }
                    else
                    {
                        lastStrategy = "Confluence Trigger";
                    }

                    lastSignal = string.Format("{0} {1} Contract(s) @ {2}", action, qty, entryPrice.ToString("F2"));
                    
                    if (!isTradingEnabled)
                    {
                        Print("AntigravityBridge: BUY/SELL signal ignored. Strategy is suspended (OFF) on dashboard.");
                        return;
                    }
                    
                    UpdateChartOverlay();

                    // Calculate tick differences for NinjaTrader SL/TP order attachments
                    double stopLossTicks = Math.Abs(entryPrice - stopLoss) / TickSize;
                    double takeProfitTicks = Math.Abs(takeProfit - entryPrice) / TickSize;

                    // Set stop loss and profit targets programmatically
                    SetStopLoss(CalculationMode.Ticks, stopLossTicks);
                    SetProfitTarget(CalculationMode.Ticks, takeProfitTicks);

                    if (action == "BUY")
                    {
                        if (Position.MarketPosition != MarketPosition.Flat)
                        {
                            Print("AntigravityBridge: BUY signal ignored. Already in active position: " + Position.MarketPosition);
                            return;
                        }
                        Print(string.Format("AntigravityBridge: Submitting BUY market order. Qty: {0}, SL: {1} ticks, TP: {2} ticks", qty, stopLossTicks, takeProfitTicks));
                        EnterLong(qty, "AntigravityLong");
                    }
                    else if (action == "SELL")
                    {
                        if (Position.MarketPosition != MarketPosition.Flat)
                        {
                            Print("AntigravityBridge: SELL signal ignored. Already in active position: " + Position.MarketPosition);
                            return;
                        }
                        Print(string.Format("AntigravityBridge: Submitting SELL market order. Qty: {0}, SL: {1} ticks, TP: {2} ticks", qty, stopLossTicks, takeProfitTicks));
                        EnterShort(qty, "AntigravityShort");
                    }
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
