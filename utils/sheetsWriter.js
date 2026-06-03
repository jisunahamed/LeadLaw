function toColumnLetters(index) {
  let value = index + 1;
  let letters = "";
  while (value > 0) {
    const mod = (value - 1) % 26;
    letters = String.fromCharCode(65 + mod) + letters;
    value = Math.floor((value - mod) / 26);
  }
  return letters;
}

function toCellRef(row, col) {
  return `${toColumnLetters(col)}${row}`;
}

function safeCellValue(input) {
  return String(input ?? "").replace(/\r?\n/g, " ").trim();
}

if (typeof module !== "undefined") {
  module.exports = {
    toColumnLetters,
    toCellRef,
    safeCellValue
  };
}
