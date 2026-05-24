# NinjaTrader 8 Historical Data Export Directory

Place your exported 3-year historical files here to seed the bot's initial training and run highly accurate backtests.

## File Naming Convention
Please name your files using the standard instrument code (with or without the `=F` suffix):
*   **Nasdaq-100 (NQ):** Name the file `NQ.txt` (or `NQ.csv`)
*   **S&P 500 (ES):** Name the file `ES.txt` (or `ES.csv`)
*   **Crude Oil (CL):** Name the file `CL.txt` (or `CL.csv`)
*   **Gold (GC):** Name the file `GC.txt` (or `GC.csv`)

## Recommended Export Format in NinjaTrader 8
When exporting historical data from the **NinjaTrader 8 Historical Data** window, select the following options:
1.  **Format:** `yyyyMMdd HHmmss` or `yyyy-MM-dd HH:mm:ss`
2.  **Delimiter:** Semicolon (`;`), Comma (`,`), or Tab.
3.  **Data Columns:** `DateTime;Open;High;Low;Close;Volume`

The bot's built-in parser is highly flexible and will automatically detect the delimiters, sort the candles chronologically, and parse the ticks into standard OHLCV candle streams for deep ML base-setting parameter optimization and high-fidelity backtests!
