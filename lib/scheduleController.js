// Handles the trading schedule, CME maintenance windows, weekends, and US holidays.
// All times are evaluated in America/Los_Angeles (Pacific Time - PT)

// US Market Holidays list (2026 and 2027)
const US_HOLIDAYS = [
  // 2026
  '2026-01-01', // New Year's Day
  '2026-01-19', // Martin Luther King Jr. Day
  '2026-02-16', // Presidents' Day
  '2026-04-03', // Good Friday
  '2026-05-25', // Memorial Day
  '2026-06-19', // Juneteenth
  '2026-07-04', // Independence Day
  '2026-09-07', // Labor Day
  '2026-11-26', // Thanksgiving
  '2026-12-25', // Christmas
  // 2027
  '2027-01-01',
  '2027-01-18',
  '2027-02-15',
  '2027-03-26',
  '2027-05-31',
  '2027-06-18',
  '2027-07-05',
  '2027-09-06',
  '2027-11-25',
  '2027-12-24'
];

function getPTDateTime() {
  const d = new Date();
  
  // Format to get local time in America/Los_Angeles timezone
  const ptString = d.toLocaleString('en-US', { timeZone: 'America/Los_Angeles' });
  const ptDate = new Date(ptString);
  
  const year = ptDate.getFullYear();
  const month = String(ptDate.getMonth() + 1).padStart(2, '0');
  const date = String(ptDate.getDate()).padStart(2, '0');
  const hours = ptDate.getHours();
  const minutes = ptDate.getMinutes();
  const day = ptDate.getDay(); // 0: Sunday, 1: Monday, ..., 6: Saturday
  
  const yyyymmdd = `${year}-${month}-${date}`;
  
  return {
    dateStr: yyyymmdd,
    day,
    hours,
    minutes,
    timeStr: ptDate.toLocaleTimeString('en-US'),
    rawDate: ptDate
  };
}

function checkTradingStatus() {
  const pt = getPTDateTime();
  const { dateStr, day, hours, minutes } = pt;

  // 1. Check US Holidays
  if (US_HOLIDAYS.includes(dateStr)) {
    return {
      isClosed: true,
      reason: 'US Market Holiday',
      currentTimePT: `${dateStr} ${pt.timeStr}`
    };
  }

  // 2. Check Weekend Halt
  // Friday 2:00 PM PT to Sunday 3:00 PM PT
  if (day === 5 && hours >= 14) { // Friday after 2:00 PM PT
    return {
      isClosed: true,
      reason: 'Weekend Close (Friday)',
      currentTimePT: `${dateStr} ${pt.timeStr}`
    };
  }
  if (day === 6) { // Saturday
    return {
      isClosed: true,
      reason: 'Weekend Close (Saturday)',
      currentTimePT: `${dateStr} ${pt.timeStr}`
    };
  }
  if (day === 0 && hours < 15) { // Sunday before 3:00 PM PT
    return {
      isClosed: true,
      reason: 'Weekend Close (Sunday morning)',
      currentTimePT: `${dateStr} ${pt.timeStr}`
    };
  }

  // 3. Check CME Daily Maintenance Window
  // CME Globex closes 5:00 PM ET / 4:00 PM CT and reopens 6:00 PM ET / 5:00 PM CT
  // (Mon-Thu). That's 2:00 PM - 3:00 PM Pacific. Friday omitted because the
  // week-end weekend close at 2:00 PM PT already covers that hour.
  if (day >= 1 && day <= 4) {
    if (hours === 14) {
      return {
        isClosed: true,
        reason: 'CME Daily Maintenance Window (2 PM - 3 PM PT)',
        currentTimePT: `${dateStr} ${pt.timeStr}`
      };
    }
  }

  // Active trading
  return {
    isClosed: false,
    reason: 'Active Session',
    currentTimePT: `${dateStr} ${pt.timeStr}`
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Market clock: returns the NEXT session change after `now` (PT) so the
// dashboard can render a live countdown ("RTH opens in 9h 23m" etc.).
//
// CME futures (NQ/ES/CL/GC) schedule, expressed in Pacific Time:
//   • Sun 3:00 PM PT          → Globex Open (week start)
//   • Mon-Thu 6:30 AM PT      → RTH Open
//   • Mon-Thu 1:00 PM PT      → RTH Close
//   • Mon-Thu 2:00 PM PT      → CME Maintenance starts (1-hour break)
//   • Mon-Thu 3:00 PM PT      → ETH Resumes (after maintenance)
//   • Fri 6:30 AM PT          → RTH Open
//   • Fri 1:00 PM PT          → RTH Close
//   • Fri 2:00 PM PT          → Weekend Close (until Sun 3 PM PT)
//   • US holidays             → market closed, sessions skipped
// ─────────────────────────────────────────────────────────────────────────────
function _ymd(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

function getNextSessionChange() {
  const pt = getPTDateTime();
  const now = pt.rawDate;

  // Build list of candidate session boundaries over the next 8 days
  const events = [];
  for (let dayOffset = 0; dayOffset < 8; dayOffset++) {
    const date = new Date(now.getTime() + dayOffset * 86400000);
    date.setHours(0, 0, 0, 0);
    const dow = date.getDay();
    const dateStr = _ymd(date);

    if (US_HOLIDAYS.includes(dateStr)) continue;

    // Sunday: Globex opens 3 PM PT
    if (dow === 0) {
      events.push({ type: 'globex_open', label: 'Globex Opens', date, hour: 15, minute: 0 });
    }
    // Mon-Fri: RTH window
    if (dow >= 1 && dow <= 5) {
      events.push({ type: 'rth_open',  label: 'RTH Opens',  date, hour:  6, minute: 30 });
      events.push({ type: 'rth_close', label: 'RTH Closes', date, hour: 13, minute:  0 });
      if (dow === 5) {
        events.push({ type: 'weekend_close', label: 'Weekend Close', date, hour: 14, minute: 0 });
      } else {
        events.push({ type: 'maintenance_start', label: 'CME Maintenance', date, hour: 14, minute: 0 });
        events.push({ type: 'maintenance_end',   label: 'ETH Resumes',     date, hour: 15, minute: 0 });
      }
    }
  }

  // Sort events by timestamp and pick the first one strictly in the future
  events.forEach(e => {
    const ts = new Date(e.date);
    ts.setHours(e.hour, e.minute, 0, 0);
    e.atTs = ts.getTime();
  });
  events.sort((a, b) => a.atTs - b.atTs);

  const nowTs = now.getTime();
  const next = events.find(e => e.atTs > nowTs);
  if (!next) return null;
  return {
    type:  next.type,
    label: next.label,
    atTs:  next.atTs,
    inMs:  next.atTs - nowTs
  };
}

// Classifies the CURRENT market session state into one of:
//   'holiday' · 'weekend' · 'maintenance' · 'rth' · 'eth'
// Used by the dashboard market clock widget to color the indicator.
function getCurrentSessionState() {
  const pt = getPTDateTime();
  const { dateStr, day, hours, minutes } = pt;

  if (US_HOLIDAYS.includes(dateStr)) return 'holiday';
  if (day === 6) return 'weekend';
  if (day === 0 && hours < 15) return 'weekend';
  if (day === 5 && hours >= 14) return 'weekend';
  if (day >= 1 && day <= 4 && hours === 14) return 'maintenance';
  // RTH window: Mon-Fri 6:30 AM - 1:00 PM PT
  if (day >= 1 && day <= 5) {
    const afterRthOpen  = (hours > 6)  || (hours === 6  && minutes >= 30);
    const beforeRthClose= (hours < 13);
    if (afterRthOpen && beforeRthClose) return 'rth';
  }
  return 'eth';
}

module.exports = {
  checkTradingStatus,
  getPTDateTime,
  getNextSessionChange,
  getCurrentSessionState
};
