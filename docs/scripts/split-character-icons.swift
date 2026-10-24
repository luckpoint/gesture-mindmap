import AppKit
import ImageIO
import UniformTypeIdentifiers
// This coordinate preset is for the 1055 × 1491 character icon sheet only.
guard CommandLine.arguments.count == 3 else {
 fputs("Usage: swift docs/scripts/split-character-icons.swift <source.png> <new-output-directory>\n", stderr)
 exit(1)
}
let source = URL(fileURLWithPath: CommandLine.arguments[1])
let output = URL(fileURLWithPath: CommandLine.arguments[2], isDirectory: true)
guard !FileManager.default.fileExists(atPath: output.path) else {
 fputs("Output directory already exists; choose a new path.\n", stderr)
 exit(1)
}
let imageSource = CGImageSourceCreateWithURL(source as CFURL, nil)!
let original = CGImageSourceCreateImageAtIndex(imageSource, 0, nil)!
precondition(original.width == 1055 && original.height == 1491, "Expected a 1055 × 1491 source image")
try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)
let names = ["男の子_赤ちゃん1", "男の子_赤ちゃん2", "男の子_赤ちゃん3", "男の子_赤ちゃん4", "男の子_小学生1", "男の子_小学生2", "男の子_小学生3", "男の子_小学生4", "男子高校生1", "男子高校生2", "男子高校生3", "男子高校生4", "男子高校生5", "男子高校生6", "男子高校生7", "男子高校生8", "男性20代1", "男性20代2", "男性20代3", "男性20代4", "男性20代5", "男性20代6", "男性20代7", "男性20代8", "男性40代1", "男性40代2", "男性40代3", "男性40代4", "男性40代5", "男性40代6", "男性40代7", "男性40代8", "男性老人1", "男性老人2", "男性老人3", "男性老人4", "女の子_赤ちゃん1", "女の子_赤ちゃん2", "女の子_赤ちゃん3", "女の子_赤ちゃん4", "女の子_小学生1", "女の子_小学生2", "女の子_小学生3", "女の子_小学生4", "女子高校生1", "女子高校生2", "女子高校生3", "女子高校生4", "女子高校生5", "女子高校生6", "女子高校生7", "女子高校生8", "女性20代1", "女性20代2", "女性20代3", "女性20代4", "女性20代5", "女性20代6", "女性20代7", "女性20代8", "女性40代1", "女性40代2", "女性40代3", "女性40代4", "女性40代5", "女性40代6", "女性40代7", "女性40代8", "女性老人1", "女性老人2", "女性老人3", "女性老人4"]
let xs = [4,180,354,528,702,877,1051]
let ys = [71,186,304,423,543,664,785,906,1027,1147,1267,1380,1488]
let ends = [164,282,400,520,640,761,882,1003,1123,1244,1359,1466]
precondition(names.count == 72 && xs.count == 7 && ys.count == 13 && ends.count == 12)
let colorSpace = CGColorSpaceCreateDeviceRGB()
func writePNG(_ image: CGImage, _ url: URL) {
 let dest = CGImageDestinationCreateWithURL(url as CFURL, UTType.png.identifier as CFString, 1, nil)!
 CGImageDestinationAddImage(dest, image, nil)
 precondition(CGImageDestinationFinalize(dest))
}
let preview = CGContext(data:nil,width:768,height:1344,bitsPerComponent:8,bytesPerRow:768*4,space:colorSpace,bitmapInfo:CGImageAlphaInfo.premultipliedLast.rawValue)!
preview.setFillColor(CGColor(gray:1,alpha:1)); preview.fill(CGRect(x:0,y:0,width:768,height:1344))
for i in 0..<72 {
 let r=i/6, c=i%6
 let rect=CGRect(x:xs[c]+3,y:ys[r]+2,width:xs[c+1]-xs[c]-6,height:ends[r]-ys[r]-2)
 let crop=original.cropping(to:rect)!
 let rep=NSBitmapImageRep(cgImage:crop)
 var minX=crop.width, minY=crop.height, maxX=0, maxY=0
 for y in 0..<crop.height { for x in 0..<crop.width {
  let color=rep.colorAt(x:x,y:y)!.usingColorSpace(.deviceRGB)!
  if min(color.redComponent,color.greenComponent,color.blueComponent)<0.65 {
   minX=min(minX,x); maxX=max(maxX,x); minY=min(minY,y); maxY=max(maxY,y)
  }
 }}
 precondition(minX<=maxX && minY<=maxY)
 let bx=max(0,minX-3), by=max(0,minY-3)
 let bounds=CGRect(x:bx,y:by,width:min(crop.width,maxX+4)-bx,height:min(crop.height,maxY+4)-by)
 let tight=crop.cropping(to:bounds)!
 precondition(tight.width <= 128 && tight.height <= 112, "Icon exceeds the canvas")
 let canvas=CGContext(data:nil,width:128,height:112,bitsPerComponent:8,bytesPerRow:512,space:colorSpace,bitmapInfo:CGImageAlphaInfo.premultipliedLast.rawValue)!
 canvas.setFillColor(CGColor(gray:1,alpha:1)); canvas.fill(CGRect(x:0,y:0,width:128,height:112))
 canvas.draw(tight,in:CGRect(x:(128-tight.width)/2,y:(112-tight.height)/2,width:tight.width,height:tight.height))
 let result=canvas.makeImage()!
 writePNG(result,output.appendingPathComponent(String(format:"%02d_",i+1)+names[i]+".png"))
 preview.draw(result,in:CGRect(x:c*128,y:(11-r)*112,width:128,height:112))
}
writePNG(preview.makeImage()!,output.appendingPathComponent("preview.png"))
print("Created 72 PNGs in \(output.path)")
