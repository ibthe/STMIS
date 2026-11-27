import Foundation
import ScreenCaptureKit
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers
import Vision

// capture shot <displayID> <x> <y> <w> <h> <pixelW> <pixelH> <excludePid> <out.png>
// capture scan <displayID> <x> <y> <w> <h> <pixelW> <pixelH> <excludePid> <langs,csv|"">   -> JSON в stdout
// x,y,w,h — точки относительно дисплея. Окна процесса excludePid в кадр не попадают.

func fail(_ code: Int32, _ msg: String) -> Never {
    FileHandle.standardError.write(Data((msg + "\n").utf8))
    exit(code)
}

func grab(did: UInt32, x: Double, y: Double, w: Double, h: Double, pw: Int, ph: Int, pid: Int32) async throws -> CGImage {
    let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
    guard let disp = content.displays.first(where: { $0.displayID == did }) ?? content.displays.first else { fail(3, "нет дисплея") }
    let apps = content.applications.filter { $0.processID == pid }
    let filter = SCContentFilter(display: disp, excludingApplications: apps, exceptingWindows: [])
    let cfg = SCStreamConfiguration()
    cfg.sourceRect = CGRect(x: x, y: y, width: w, height: h)
    cfg.width = pw
    cfg.height = ph
    cfg.showsCursor = false
    return try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: cfg)
}

func recognize(_ img: CGImage, langs: [String]) throws -> [[String: Any]] {
    let req = VNRecognizeTextRequest()
    req.recognitionLevel = .accurate
    req.usesLanguageCorrection = true
    if langs.isEmpty { req.automaticallyDetectsLanguage = true } else { req.recognitionLanguages = langs }
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
        guard a.count >= 11, let did = UInt32(a[2]), let x = Double(a[3]), let y = Double(a[4]),
              let w = Double(a[5]), let h = Double(a[6]), let pw = Int(a[7]), let ph = Int(a[8]),
              let pid = Int32(a[9]) else { fail(2, "неверные аргументы") }
        do {
            let img = try await grab(did: did, x: x, y: y, w: w, h: h, pw: pw, ph: ph, pid: pid)
            if a[1] == "shot" {
                guard let dest = CGImageDestinationCreateWithURL(URL(fileURLWithPath: a[10]) as CFURL, UTType.png.identifier as CFString, 1, nil) else { fail(4, "png") }
                CGImageDestinationAddImage(dest, img, nil)
                guard CGImageDestinationFinalize(dest) else { fail(5, "png") }
            } else {
                let langs = a[10].split(separator: ",").map(String.init)
                let lines = try recognize(img, langs: langs)
                let data = try JSONSerialization.data(withJSONObject: ["lines": lines])
                FileHandle.standardOutput.write(data)
            }
            exit(0)
        } catch {
            fail(1, "\(error)")
        }
    }
}
