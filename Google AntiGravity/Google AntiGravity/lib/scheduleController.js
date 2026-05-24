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
  // Monday to Thursday 2:00 PM to 3:00 PM PT
  // Note: Friday maintenance doesn't matter because market closes at 2:00 PM PT anyway.
  if (day >= 1 && day <= 4) {
    if (hours === 14) { // Between 2:00 PM and 2:59 PM PT
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

module.exports = {
  checkTradingStatus,
  getPTDateTime
};
