import { imagePixels, runNativeTask } from "../native.js"
import { makeBox } from "../canvas.js"
import { overlapScore, toCoordinates, toRectangle } from "../placement.js"
import { groupOcrLines, mapOcrBox } from "../ocr.js"

export function setupOcr({
  state,
  byId,
  status,
  checkpoint,
  renderPages,
  render,
  selectedPage,
  selectedBox,
  projectBusy,
  notifyOverflowIfAny,
}) {
  let review
  const dialog = byId("ocr-review")
  async function localProcessing(preview) {
    const page = selectedPage()
    if (!page || projectBusy()) return
    const crop = byId("ocr-crop").checked ? selectedBox() : null
    if (byId("ocr-crop").checked && !crop)
      return status("Hãy chọn khung để cắt vùng OCR.", true)
    state.processingNative = true
    renderPages()
    status(preview ? "Đang tiền xử lý ảnh…" : "Đang nhận dạng chữ trên máy…")
    try {
      const sample = imagePixels(page.image, crop)
      const options = {
        width: sample.width,
        height: sample.height,
        scale: Number(byId("ocr-scale").value),
        denoise: byId("ocr-denoise").checked,
        language: byId("local-ocr-language").value,
        psm: Number(byId("local-ocr-layout").value),
        rotation: Number(byId("ocr-rotation").value),
      }
      const { result, data } = await runNativeTask(
        preview ? "preprocess" : "ocr",
        options,
        sample.pixels,
      )
      if (preview) {
        const canvas = byId("ocr-preview-canvas")
        canvas.width = result.width
        canvas.height = result.height
        canvas
          .getContext("2d")
          .putImageData(
            new ImageData(
              new Uint8ClampedArray(data),
              result.width,
              result.height,
            ),
            0,
            0,
          )
        byId("ocr-preview").showModal()
        status("Đã tạo ảnh tiền xử lý.")
      } else {
        const lines = result.lines.map((line) => ({
          ...line,
          box: mapOcrBox(line.box, sample, page.image),
        }))
        review = {
          page,
          lines: groupOcrLines(lines, {
            vertical: options.psm === 5,
            direction: byId("direction").value,
            group: byId("ocr-group").checked,
          }),
        }
        byId("ocr-review-lines").replaceChildren(
          ...review.lines.map((line, index) => {
            const row = document.createElement("label")
            row.className = "field"
            row.textContent =
              "Vùng " +
              (index + 1) +
              " · độ tin cậy " +
              Math.round(line.confidence) +
              "%"
            const text = document.createElement("textarea")
            text.value = line.text
            text.rows = 3
            text.oninput = () => {
              line.text = text.value
            }
            const thumbnail = document.createElement("canvas")
            const [left, top, right, bottom] = line.box
            const width = ((right - left) / 1000) * page.image.naturalWidth
            const height = ((bottom - top) / 1000) * page.image.naturalHeight
            const ratio = Math.min(1, 320 / width, 120 / height)
            thumbnail.width = Math.max(1, Math.round(width * ratio))
            thumbnail.height = Math.max(1, Math.round(height * ratio))
            thumbnail.setAttribute("aria-label", "Ảnh vùng OCR " + (index + 1))
            thumbnail
              .getContext("2d")
              .drawImage(
                page.image,
                (left / 1000) * page.image.naturalWidth,
                (top / 1000) * page.image.naturalHeight,
                width,
                height,
                0,
                0,
                thumbnail.width,
                thumbnail.height,
              )
            row.append(thumbnail, text)
            return row
          }),
        )
        byId("ocr-review-summary").textContent = review.lines.length
          ? "Sửa nội dung trước khi đặt. Xóa nội dung để bỏ qua vùng."
          : "Không tìm được chữ trong vùng này."
        dialog.showModal()
      }
    } catch (error) {
      status(error.message, true)
    } finally {
      state.processingNative = false
      render()
    }
  }

  byId("apply-ocr").onclick = () => {
    if (!review || projectBusy() || !state.pages.includes(review.page)) return
    checkpoint()
    let applied = 0
    for (const line of review.lines) {
      line.text = line.text.trim()
      if (!line.text) continue
      const overlapping = review.page.boxes.find(
        (box) => overlapScore(toCoordinates(box), line.box) > 0.5,
      )
      if (overlapping) {
        if (
          overlapping.text !== line.text &&
          !review.page.unplaced.some((item) => item.text === line.text)
        )
          review.page.unplaced.push(line)
      } else {
        const box = makeBox(review.page, toRectangle(line.box), line.text)
        box.fill = false
        review.page.boxes.push(box)
      }
      applied++
    }
    const appliedPage = review.page
    dialog.close()
    render()
    status(
      `Đã áp dụng ${applied} vùng OCR. Vùng chồng khung có sẵn được đưa vào Chưa đặt.`,
    )
    if (applied > 0) notifyOverflowIfAny?.(appliedPage, "sau khi áp dụng OCR")
  }
  byId("cancel-ocr").onclick = () => dialog.close()
  dialog.addEventListener("close", () => {
    review = null
  })
  byId("preview-ocr").onclick = () => localProcessing(true)
  byId("run-local-ocr").onclick = () => localProcessing(false)
}
