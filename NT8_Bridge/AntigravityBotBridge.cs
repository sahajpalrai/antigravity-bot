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

            // Dynamically calculate and plot indicators using parsed variables from TCP bridge
            // 1. RTH Session Trend Crossovers (EMA Fast and Slow)
            Values[0][0] = EMA(parsedEmaFast)[0];
            Values[1][0] = EMA(parsedEmaSlow)[0];

            // 2. ETH Session Mean Reversion (Bollinger Bands Upper and Lower)
            Values[2][0] = Bollinger(parsedBbDev, 20).Upper[0];
            Values[3][0] = Bollinger(parsedBbDev, 20).Lower[0];
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
                    wpfPanel.Width = 380;
                    wpfPanel.Height = 240;
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
            string statusText = isConnected ? "CONNECTED TO BOT" : "DISCONNECTED (RETRYING...)";

            string labelText = string.Format(
                "🚀 ANTIGRAVITY V1 SMART BOT BRIDGE\n" +
                "==================================================\n" +
                "• Status: {0}\n" +
                "• Timeframe: {1}-Minute Chart (Execution Mode)\n" +
                "• Last Signal: {2}\n" +
                "• Strategy Triggered: {3}\n" +
                "--------------------------------------------------\n" +
                "📊 ACTIVE MACHINE LEARNING PARAMETERS:\n" +
                "{4}",
                statusText,
                BarsPeriod.Value,
                lastSignal,
                lastStrategy,
                activeParamsText
            );

            if (wpfTextBlock != null)
            {
                ChartControl.Dispatcher.InvokeAsync(new Action(() => {
                    wpfTextBlock.Text = labelText;
                    
                    // Dynamically set border color based on status
                    if (wpfPanel != null)
                    {
                        var color = isConnected 
                            ? Color.FromRgb(57, 255, 20)  // Neon green
                            : Color.FromRgb(255, 56, 56); // Neon red
                        wpfPanel.BorderBrush = new SolidColorBrush(color);
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
                    
                    if (parts.Length >= 7)
                    {
                        lastStrategy = parts[6];
                    }
                    else
                    {
                        lastStrategy = "Confluence Trigger";
                    }

                    lastSignal = string.Format("{0} {1} Contract(s) @ {2}", action, qty, entryPrice.ToString("F2"));
                    UpdateChartOverlay();

                    // Calculate tick differences for NinjaTrader SL/TP order attachments
                    double stopLossTicks = Math.Abs(entryPrice - stopLoss) / TickSize;
                    double takeProfitTicks = Math.Abs(takeProfit - entryPrice) / TickSize;

                    // Set stop loss and profit targets programmatically
                    SetStopLoss(CalculationMode.Ticks, stopLossTicks);
                    SetProfitTarget(CalculationMode.Ticks, takeProfitTicks);

                    if (action == "BUY")
                    {
                        Print(string.Format("AntigravityBridge: Submitting BUY market order. Qty: {0}, SL: {1} ticks, TP: {2} ticks", qty, stopLossTicks, takeProfitTicks));
                        EnterLong(qty, "AntigravityLong");
                    }
                    else if (action == "SELL")
                    {
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
