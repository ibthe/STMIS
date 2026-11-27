import Foundation
import ScreenCaptureKit
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers

// capture <displayID> <x> <y> <w> <h> <pixelW> <pixelH> <excludePid> <out.png>
// x,y,w,h — в точках относительно дисплея; окна процесса excludePid в кадр не попадают
@main
struct Capture {
    static func main() async {
        let a = CommandLine.arguments
        guard a.count >= 10,
              let did = UInt32(a[1]), let x = Double(a[2]), let y = Double(a[3]),
              let w = Double(a[4]), let h = Double(a[5]),
              let pw = Int(a[6]), let ph = Int(a[7]), let pid = Int32(a[8]) else { exit(2) }
        let out = a[9]
        do {
            let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
            guard let disp = content.displays.first(where: { $0.displayID == did }) ?? content.displays.first else { exit(3) }
            let apps = content.applications.filter { $0.processID == pid }
            let filter = SCContentFilter(display: disp, excludingApplications: apps, exceptingWindows: [])
            let cfg = SCStreamConfiguration()
            cfg.sourceRect = CGRect(x: x, y: y, width: w, height: h)
            cfg.width = pw
            cfg.height = ph
            cfg.showsCursor = false
            let img = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: cfg)
            guard let dest = CGImageDestinationCreateWithURL(URL(fileURLWithPath: out) as CFURL, UTType.png.identifier as CFString, 1, nil) else { exit(4) }
            CGImageDestinationAddImage(dest, img, nil)
            guard CGImageDestinationFinalize(dest) else { exit(5) }
            exit(0)
        } catch {
            FileHandle.standardError.write(Data("\(error)\n".utf8))
            exit(1)
        }
    }
}
