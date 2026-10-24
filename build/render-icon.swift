import AppKit
let size = 1024
let cs = CGColorSpace(name: CGColorSpace.sRGB)!
let c = CGContext(data:nil,width:size,height:size,bitsPerComponent:8,bytesPerRow:0,space:cs,bitmapInfo:CGImageAlphaInfo.premultipliedLast.rawValue)!
let rect = CGRect(x:80,y:80,width:864,height:864)
let shape = CGPath(roundedRect:rect,cornerWidth:210,cornerHeight:210,transform:nil)
c.addPath(shape);c.saveGState();c.clip()
let gradient = CGGradient(colorsSpace:cs,colors:[NSColor(calibratedRed:0.14,green:0.15,blue:0.23,alpha:1).cgColor,NSColor(calibratedRed:0.06,green:0.065,blue:0.105,alpha:1).cgColor] as CFArray,locations:[0,1])!
c.drawLinearGradient(gradient,start:CGPoint(x:100,y:950),end:CGPoint(x:900,y:50),options:[]);c.restoreGState()
c.addPath(shape);c.setStrokeColor(NSColor(white:1,alpha:0.12).cgColor);c.setLineWidth(4);c.strokePath()
c.setLineWidth(48);c.setLineCap(.round)
for (i, pair) in [(320.0,124.0),(416.0,316.0),(512.0,476.0),(608.0,252.0),(704.0,92.0)].enumerated(){
 let (x,h)=pair;c.setStrokeColor(NSColor(calibratedRed:0.95-Double(i)*0.05,green:0.925-Double(i)*0.06,blue:0.89+Double(i)*0.015,alpha:1).cgColor)
 c.move(to:CGPoint(x:x,y:512-h/2));c.addLine(to:CGPoint(x:x,y:512+h/2));c.strokePath()
}
let rep=NSBitmapImageRep(cgImage:c.makeImage()!)
try rep.representation(using:.png,properties:[:])!.write(to:URL(fileURLWithPath:CommandLine.arguments[1]))
