const _tzFmt = {}

export function formatTZ(date, tz) {
  if (!_tzFmt[tz]) {
    _tzFmt[tz] = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz, hour12: false,
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    })
  }
  return _tzFmt[tz].format(date)
}
