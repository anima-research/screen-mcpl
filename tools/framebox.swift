// framebox — diff two frames, box the changed regions, write a downscaled JPEG.
// usage: framebox <cur.png> <out.jpg> <maxPx> [prev.png]
// Prints JSON {"boxes":N,"changePercent":P} on stdout. No boxes when prev is absent.
import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

func load(_ path: String) -> CGImage? {
    guard let src = CGImageSourceCreateWithURL(URL(fileURLWithPath: path) as CFURL, nil) else { return nil }
    return CGImageSourceCreateImageAtIndex(src, 0, nil)
}

/// Grayscale thumbnail of fixed cell grid resolution for a cheap block diff.
func luma(_ img: CGImage, w: Int, h: Int) -> [UInt8] {
    var px = [UInt8](repeating: 0, count: w * h)
    px.withUnsafeMutableBytes { buf in
        guard let ctx = CGContext(data: buf.baseAddress, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w,
                                  space: CGColorSpaceCreateDeviceGray(), bitmapInfo: CGImageAlphaInfo.none.rawValue) else { return }
        ctx.interpolationQuality = .medium
        ctx.draw(img, in: CGRect(x: 0, y: 0, width: w, height: h))
    }
    return px
}

let args = CommandLine.arguments
guard args.count >= 4, let cur = load(args[1]), let maxPx = Double(args[3]) else {
    FileHandle.standardError.write("usage: framebox <cur.png> <out.jpg> <maxPx> [prev.png]\n".data(using: .utf8)!)
    exit(2)
}
let prev = args.count >= 5 ? load(args[4]) : nil

// Changed cells on a grid of ~cell px; boxes are merged runs of changed cells.
let W = cur.width, H = cur.height
let cell = max(8, Int(Double(max(W, H)) / 96.0))      // ~96 cells along the long side
let gw = max(1, W / cell), gh = max(1, H / cell)
var boxes: [CGRect] = []
var changePercent = 0.0
if let prev = prev, prev.width == W, prev.height == H {
    let a = luma(prev, w: gw, h: gh), b = luma(cur, w: gw, h: gh)
    var changed = [Bool](repeating: false, count: gw * gh)
    var n = 0
    for i in 0..<(gw * gh) where abs(Int(a[i]) - Int(b[i])) > 12 { changed[i] = true; n += 1 }
    changePercent = 100.0 * Double(n) / Double(gw * gh)
    // Dilate by one cell so nearby runs merge, then take connected components (4-neighbour flood fill).
    var dil = changed
    for y in 0..<gh { for x in 0..<gw where changed[y * gw + x] {
        for dy in -1...1 { for dx in -1...1 {
            let nx = x + dx, ny = y + dy
            if nx >= 0, ny >= 0, nx < gw, ny < gh { dil[ny * gw + nx] = true }
        } }
    } }
    var seen = [Bool](repeating: false, count: gw * gh)
    for start in 0..<(gw * gh) where dil[start] && !seen[start] {
        var stack = [start]; seen[start] = true
        var minX = gw, minY = gh, maxX = -1, maxY = -1, count = 0
        while let i = stack.popLast() {
            let x = i % gw, y = i / gw
            if changed[i] { minX = min(minX, x); minY = min(minY, y); maxX = max(maxX, x); maxY = max(maxY, y); count += 1 }
            for (dx, dy) in [(1, 0), (-1, 0), (0, 1), (0, -1)] {
                let nx = x + dx, ny = y + dy
                if nx >= 0, ny >= 0, nx < gw, ny < gh { let j = ny * gw + nx; if dil[j] && !seen[j] { seen[j] = true; stack.append(j) } }
            }
        }
        if count > 0 {
            boxes.append(CGRect(x: minX * cell, y: minY * cell, width: (maxX - minX + 1) * cell, height: (maxY - minY + 1) * cell))
        }
    }
    boxes.sort { $0.width * $0.height > $1.width * $1.height }
    if boxes.count > 12 { boxes = Array(boxes.prefix(12)) }
}

// Render: downscale to maxPx, draw boxes (CG origin is bottom-left; our boxes are top-left).
let scale = min(1.0, maxPx / Double(max(W, H)))
let ow = max(1, Int(Double(W) * scale)), oh = max(1, Int(Double(H) * scale))
guard let ctx = CGContext(data: nil, width: ow, height: oh, bitsPerComponent: 8, bytesPerRow: 0,
                          space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { exit(3) }
ctx.interpolationQuality = .high
ctx.draw(cur, in: CGRect(x: 0, y: 0, width: ow, height: oh))
if !boxes.isEmpty {
    ctx.setStrokeColor(CGColor(red: 1.0, green: 0.2, blue: 0.2, alpha: 0.9))
    ctx.setLineWidth(max(2.0, Double(ow) * 0.003))
    for b in boxes {
        let r = CGRect(x: b.minX * scale, y: Double(oh) - (b.maxY * scale), width: b.width * scale, height: b.height * scale).insetBy(dx: -2, dy: -2)
        ctx.stroke(r)
    }
}
guard let out = ctx.makeImage(),
      let dest = CGImageDestinationCreateWithURL(URL(fileURLWithPath: args[2]) as CFURL, UTType.jpeg.identifier as CFString, 1, nil) else { exit(4) }
CGImageDestinationAddImage(dest, out, [kCGImageDestinationLossyCompressionQuality: 0.72] as CFDictionary)
guard CGImageDestinationFinalize(dest) else { exit(5) }
print("{\"boxes\":\(boxes.count),\"changePercent\":\(String(format: "%.2f", changePercent))}")
