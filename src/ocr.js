export function mapOcrBox(box, sample, image) {
  const [left, top, right, bottom] = box
  return [
    (sample.left + left / 1000 * sample.width) / image.naturalWidth * 1000,
    (sample.top + top / 1000 * sample.height) / image.naturalHeight * 1000,
    (sample.left + right / 1000 * sample.width) / image.naturalWidth * 1000,
    (sample.top + bottom / 1000 * sample.height) / image.naturalHeight * 1000,
  ].map((value) => Math.max(0, Math.min(1000, Math.round(value))))
}

export function groupOcrLines(lines, { vertical = false, direction = "rtl", group = true } = {}) {
  const pending = lines.filter(({ box }) => box && box[2] > box[0] && box[3] > box[1])
    .map((line) => ({ ...line, box: [...line.box] }))
  const result = []
  const order = (a, b) => vertical ? b.box[0] - a.box[0] || a.box[1] - b.box[1] :
    a.box[1] - b.box[1] || (direction === "rtl" ? b.box[0] - a.box[0] : a.box[0] - b.box[0])
  while (pending.length) {
    const members = [pending.shift()]
    if (group) {
      for (let index = 0; index < members.length; index++) {
        for (let next = pending.length - 1; next >= 0; next--) {
          if (adjacent(members[index].box, pending[next].box, vertical)) members.push(...pending.splice(next, 1))
        }
      }
    }
    members.sort(order)
    result.push({
      id: "L" + (result.length + 1),
      text: members.map(({ text }) => text).join("\n"),
      confidence: Math.min(...members.map(({ confidence }) => confidence ?? 100)),
      box: [
        Math.min(...members.map(({ box }) => box[0])), Math.min(...members.map(({ box }) => box[1])),
        Math.max(...members.map(({ box }) => box[2])), Math.max(...members.map(({ box }) => box[3])),
      ],
    })
  }
  return result.sort(order)
}

function adjacent(a, b, vertical) {
  const axis = vertical ? 1 : 0
  const flow = vertical ? 0 : 1
  const overlap = Math.min(a[axis + 2], b[axis + 2]) - Math.max(a[axis], b[axis])
  const coverage = overlap / Math.min(a[axis + 2] - a[axis], b[axis + 2] - b[axis])
  const gap = Math.max(a[flow], b[flow]) - Math.min(a[flow + 2], b[flow + 2])
  const size = Math.min(a[flow + 2] - a[flow], b[flow + 2] - b[flow])
  return coverage >= .35 && gap <= size * .85
}
