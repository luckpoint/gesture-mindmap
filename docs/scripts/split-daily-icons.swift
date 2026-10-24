import AppKit
import ImageIO
import UniformTypeIdentifiers
// This coordinate preset is for the 1055 × 1491 daily-life icon sheet only.
guard CommandLine.arguments.count == 3 else {
 fputs("Usage: swift docs/scripts/split-daily-icons.swift <source.png> <new-output-directory>\n", stderr)
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
let names = ["家","起床","睡眠","食事","入浴","掃除","ご飯","パン","コーヒー","お茶","水","お菓子","仕事","パソコン","会議","勉強","読書","メモ","徒歩","自転車","自動車","電車","バス","飛行機","ランニング","筋トレ","ストレッチ","病院","薬","体重計","買い物","ショッピングカート","財布","クレジットカード","貯金","レシート","洗濯","料理","ゴミ出し","皿洗い","アイロン","植物の水やり","電話","メール","チャット","ビデオ通話","通知","カレンダー","音楽","映画","ゲーム","写真","絵を描く","旅行","晴れ","曇り","雨","雪","雷","虹","学校","会社","スーパー","コンビニ","公園","レストラン","スマートフォン","Wi-Fi","バッテリー","設定","検索","ロック"]
let xs = [12,177,353,529,705,878,1043]
let ys = [62,178,293,410,532,653,774,897,1019,1140,1253,1366,1478]
let ends = [149,265,380,503,625,747,869,988,1110,1224,1340,1452]
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
 let rect=CGRect(x:xs[c]+5,y:ys[r]+5,width:xs[c+1]-xs[c]-10,height:ends[r]-ys[r]-5)
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
