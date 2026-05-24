#region Using declarations
using System;
using System.IO;
using System.Net.Sockets;
using System.Text;
using System.Threading;
using NinjaTrader.Cbi;
using NinjaTrader.Data;
using NinjaTrader.NinjaScript;
using NinjaTrader.NinjaScript.Strategies;
using NinjaTrader.NinjaScript.DrawingTools;
#endregion

namespace NinjaTrader.NinjaScript.Strategies
{
    public class AntigravityBotBridge : Strategy
    {
        // Settings parameters
        private string serverIP = "192.168.1.150"; // Replace with your Mac OS LAN IP
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
                AddPlot(new Stroke(System.Windows.Media.Brushes.Transparent), PlotStyle.Hash, "DummyPlot");
            }
            else if (State == State.Configure)
            {
                // ATM Strategy or stop/target setups can be added here
            }
            else if (State == State.Realtime)
            {
                // Connect to Node.js local TCP bridge when transition to real-time charting
                StartConnection();
            }
            else if (State == State.Terminated)
            {
                StopConnection();
            }
        }

        protected override void OnBarUpdate()
        {
            // Update the chart overlay dynamically on every bar update/tick to keep it fresh
            UpdateChartOverlay();
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
                        
                        // Force a UI label refresh on connect
                        NinjaTrader.Core.Globals.RandomDispatcher.BeginInvoke(new Action(() => {
                            UpdateChartOverlay();
                        }));
                    }
                    catch (Exception ex)
                    {
                        Print("AntigravityBridge: Connection failed. Retrying in 10 seconds... Error: " + ex.Message);
                        
                        // Force a UI label refresh on disconnect
                        NinjaTrader.Core.Globals.RandomDispatcher.BeginInvoke(new Action(() => {
                            UpdateChartOverlay();
                        }));
                        
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
                        
                        NinjaTrader.Core.Globals.RandomDispatcher.BeginInvoke(new Action(() => {
                            UpdateChartOverlay();
                        }));
                        
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
                        
                        NinjaTrader.Core.Globals.RandomDispatcher.BeginInvoke(new Action(() => {
                            UpdateChartOverlay();
                        }));
                    }
                }
            }
        }

        // Draw a beautiful status overlay on the NinjaTrader 8 Chart
        private void UpdateChartOverlay()
        {
            string statusText = isConnected ? "CONNECTED TO BOT" : "DISCONNECTED (RETRYING...)";
            System.Windows.Media.Brush statusColor = isConnected ? System.Windows.Media.Brushes.LimeGreen : System.Windows.Media.Brushes.Red;

            string labelText = string.Format(
                "🚀 ANTIGRAVITY V1 SMART BOT BRIDGE\n" +
                "--------------------------------------------------\n" +
                "• Status: {0}\n" +
                "• Timeframe: 1-Minute Chart (Execution Mode)\n" +
                "• Last Signal: {1}\n" +
                "• Strategy Triggered: {2}",
                statusText,
                lastSignal,
                lastStrategy
            );

            Draw.TextFixed(this, "AntigravityBotStatusLabel", labelText, TextPosition.TopLeft, 
                statusColor, 
                new SimpleFont("Consolas", 12) { Bold = true }, 
                System.Windows.Media.Brushes.Transparent, 
                System.Windows.Media.Brushes.Transparent, 
                0
            );
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

                    // Cancel all active pending orders first
                    CancelAllOrders();
                    
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

                    lastSignal = string.Format("{0} {1} Contract(s) @ {2}", action, qty, entryPrice.toFixed(2));
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

// Extension helper to let C# doubles format with fixed decimal points just like JS
public static class DoubleExtensions
{
    public static string toFixed(this double number, int decimals)
    {
        return number.ToString("F" + decimals);
    }
}
