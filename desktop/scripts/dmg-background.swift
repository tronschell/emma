import AppKit

if CommandLine.arguments[1] == "--verify" {
    let data = try Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[2]))
    let bookmark = CFURLCreateBookmarkDataFromAliasRecord(nil, data as CFData)!.takeRetainedValue() as Data
    var stale = false
    let resolved = try URL(resolvingBookmarkData: bookmark, options: [.withoutUI, .withoutMounting], relativeTo: nil, bookmarkDataIsStale: &stale)
    precondition(resolved.resolvingSymlinksInPath().path == URL(fileURLWithPath: CommandLine.arguments[3]).resolvingSymlinksInPath().path, "Finder must resolve the background inside the mounted image")
    let image = NSImage(contentsOf: resolved)!
    precondition(image.representations.contains { $0.pixelsWide == 640 && $0.pixelsHigh == 392 })
    precondition(image.representations.contains { $0.pixelsWide == 1280 && $0.pixelsHigh == 784 })
    exit(0)
}

let destination = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
let version = CommandLine.arguments[2]
let width = 640
let height = 392
let bayer = [
    [0, 32, 8, 40, 2, 34, 10, 42], [48, 16, 56, 24, 50, 18, 58, 26],
    [12, 44, 4, 36, 14, 46, 6, 38], [60, 28, 52, 20, 62, 30, 54, 22],
    [3, 35, 11, 43, 1, 33, 9, 41], [51, 19, 59, 27, 49, 17, 57, 25],
    [15, 47, 7, 39, 13, 45, 5, 37], [63, 31, 55, 23, 61, 29, 53, 21],
]

func color(_ hex: Int, alpha: CGFloat = 1) -> NSColor {
    NSColor(srgbRed: CGFloat((hex >> 16) & 255) / 255,
            green: CGFloat((hex >> 8) & 255) / 255,
            blue: CGFloat(hex & 255) / 255, alpha: alpha)
}

for scale in [1, 2] {
    let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: width * scale,
                                  pixelsHigh: height * scale, bitsPerSample: 8,
                                  samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
                                  colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
    bitmap.size = NSSize(width: width, height: height)
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)
    let transform = NSAffineTransform()
    transform.translateX(by: 0, yBy: CGFloat(height))
    transform.scaleX(by: 1, yBy: -1)
    transform.concat()
    color(0x1c1b1e).setFill()
    NSRect(x: 0, y: 0, width: width, height: height).fill()
    color(0xcb4e8b, alpha: 0.24).setFill()
    NSGraphicsContext.current?.shouldAntialias = false
    for y in 0..<Int(ceil(Double(height) / 1.5)) {
        for x in 0..<Int(ceil(Double(width) / 1.5)) {
            let fade = max(0, 1 - Double(x) * 1.5 / Double(width) * 0.95 - Double(y) * 1.5 / Double(height) * 1.15)
            if fade * 0.8 > (Double(bayer[y % 8][x % 8]) + 0.5) / 64 {
                NSRect(x: Double(x) * 1.5, y: Double(y) * 1.5, width: 1.5, height: 1.5).fill()
            }
        }
    }
    color(0xcf9bb3, alpha: 0.75).setFill()
    for (center, boxWidth) in [(192, 62), (448, 104)] {
        for y in 0..<30 {
            for x in 0..<boxWidth {
                let edge = min(min(x, boxWidth - 1 - x), min(y, 29 - y))
                let density = min(Double(edge) / 8, 1) * 0.8
                if density > (Double(bayer[y % 8][x % 8]) + 0.5) / 64 {
                    NSRect(x: center - boxWidth / 2 + x, y: 237 + y, width: 1, height: 1).fill()
                }
            }
        }
    }
    NSGraphicsContext.current?.shouldAntialias = true
    func text(_ value: String, y: CGFloat, font: NSFont, ink: Int, tracking: CGFloat) {
        let attributes: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: color(ink), .kern: tracking]
        let string = NSAttributedString(string: value, attributes: attributes)
        let size = string.size()
        NSGraphicsContext.saveGraphicsState()
        let flip = NSAffineTransform()
        flip.translateX(by: (CGFloat(width) - size.width) / 2, yBy: y + size.height)
        flip.scaleX(by: 1, yBy: -1)
        flip.concat()
        string.draw(at: .zero)
        NSGraphicsContext.restoreGraphicsState()
    }
    text("WELCOME TO EMMA", y: 43, font: .monospacedSystemFont(ofSize: 10, weight: .medium), ink: 0xe481ad, tracking: 2.3)
    text("Drag Emma to Applications", y: 67, font: .systemFont(ofSize: 27, weight: .medium), ink: 0xf3eef0, tracking: -0.8)
    text(version, y: 353, font: .monospacedSystemFont(ofSize: 11, weight: .regular), ink: 0xaaa1a8, tracking: 1)
    color(0xaaa1a8).setStroke()
    let arrow = NSBezierPath()
    arrow.lineWidth = 1.3
    arrow.lineCapStyle = .round
    arrow.lineJoinStyle = .round
    arrow.move(to: NSPoint(x: 305, y: 192))
    arrow.line(to: NSPoint(x: 335, y: 192))
    arrow.move(to: NSPoint(x: 326, y: 183))
    arrow.line(to: NSPoint(x: 335, y: 192))
    arrow.line(to: NSPoint(x: 326, y: 201))
    arrow.stroke()
    NSGraphicsContext.restoreGraphicsState()
    let name = scale == 1 ? "background.png" : "background@2x.png"
    try bitmap.representation(using: .png, properties: [:])!.write(to: destination.appendingPathComponent(name), options: .atomic)
}
