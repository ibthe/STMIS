import Foundation
import ScreenCaptureKit
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers
import Vision

// capture shot <displayID> <x> <y> <w> <h> <pixelW> <pixelH> <excludePid> <out.png>
//   снимок области экрана БЕЗ окон процесса excludePid (x,y,w,h — в точках относительно дисплея)
// capture ocr <image.png> <langs,csv|"">
//   распознавание текста Apple Vision, JSON со строками в stdout
// Ход работы пишется в stderr — по нему видно, где остановилась программа.

func log(_ s: String) { FileHandle.standardError.write(Data((s + "\n").utf8)) }
func fail(_ code: Int32, _ msg: String) -> Never { log(msg); exit(code) }

func grab(did: UInt32, x: Double, y: Double, w: Double, h: Double, pw: Int, ph: Int, pid: Int32) async throws -> CGImage {
    _ = CGMainDisplayID() // инициализация графической подсистемы для консольной программы
    log("shot: список экранов")
    let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
    guard let disp = content.displays.first(where: { $0.displayID == did }) ?? content.displays.first else { fail(3, "нет дисплея") }
    let apps = content.applications.filter { $0.processID == pid }
    let filter = SCContentFilter(display: disp, excludingApplications: apps, exceptingWindows: [])
    let cfg = SCStreamConfiguration()
    cfg.sourceRect = CGRect(x: x, y: y, width: w, height: h)
    cfg.width = pw
    cfg.height = ph
    cfg.showsCursor = false
    log("shot: снимок")
    return try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: cfg)
}

func recognize(_ img: CGImage, langs: [String]) throws -> [[String: Any]] {
    let req = VNRecognizeTextRequest()
    req.recognitionLevel = .accurate
    req.usesLanguageCorrection = true
    let supported = (try? req.supportedRecognitionLanguages()) ?? []
    let use = langs.filter { supported.contains($0) }
    log("ocr: языки запрошены \(langs), доступно \(supported.count), используем \(use)")
    if use.isEmpty { req.automaticallyDetectsLanguage = true } else { req.recognitionLanguages = use }
    log("ocr: распознавание (при первом запуске модель готовится, это может занять до минуты)")
    try VNImageRequestHandler(cgImage: img, options: [:]).perform([req])
    let W = Double(img.width), H = Double(img.height)
    var out: [[String: Any]] = []
    for o in req.results ?? [] {
        guard let c = o.topCandidates(1).first, c.confidence > 0.3 else { continue }
        let bb = o.boundingBox // нормализованный, начало внизу слева
        out.append(["text": c.string, "x": bb.minX * W, "y": (1 - bb.maxY) * H, "w": bb.width * W, "h": bb.height * H])
    }
    return out
}

@main
struct Tool {
    static func main() async {
        let a = CommandLine.arguments
        log("запуск: \(a.count > 1 ? a[1] : "?")")
        if a.count >= 4, a[1] == "ocr" {
            guard let src = CGImageSourceCreateWithURL(URL(fileURLWithPath: a[2]) as CFURL, nil),
                  let img = CGImageSourceCreateImageAtIndex(src, 0, nil) else { fail(6, "не удалось открыть \(a[2])") }
            log("ocr: картинка \(img.width)x\(img.height)")
            do {
                let lines = try recognize(img, langs: a[3].split(separator: ",").map(String.init))
                log("ocr: готово, строк \(lines.count)")
                FileHandle.standardOutput.write(try JSONSerialization.data(withJSONObject: ["lines": lines]))
                exit(0)
            } catch { fail(1, "Vision: \(error)") }
        }
        guard a.count >= 11, a[1] == "shot", let did = UInt32(a[2]), let x = Double(a[3]), let y = Double(a[4]),
              let w = Double(a[5]), let h = Double(a[6]), let pw = Int(a[7]), let ph = Int(a[8]),
              let pid = Int32(a[9]) else { fail(2, "неверные аргументы") }
        do {
            let img = try await grab(did: did, x: x, y: y, w: w, h: h, pw: pw, ph: ph, pid: pid)
            guard let dest = CGImageDestinationCreateWithURL(URL(fileURLWithPath: a[10]) as CFURL, UTType.png.identifier as CFString, 1, nil) else { fail(4, "png") }
            CGImageDestinationAddImage(dest, img, nil)
            guard CGImageDestinationFinalize(dest) else { fail(5, "png") }
            log("shot: готово")
            exit(0)
        } catch {
            fail(1, "\(error)")
        }
    }
}
