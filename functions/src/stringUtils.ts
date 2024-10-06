export function shortenString(fullString: string) {
  console.log('Shortening address: ' + fullString)
  var shortenedString = fullString
  if (shortenedString.length > 10) {
    shortenedString = shortenedString.substring(0, 4) + '...' + shortenedString.slice(-4)
  }
  return shortenedString
}
