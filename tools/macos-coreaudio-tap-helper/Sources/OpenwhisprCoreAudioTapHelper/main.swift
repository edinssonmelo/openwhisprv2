import AudioToolbox
import CoreAudio
import CoreFoundation
import Dispatch
import Foundation

private let magic = Data([0x4f, 0x57, 0x48, 0x41]) // OWHA
private let protocolVersion: UInt32 = 1

private func log(_ message: String) {
  FileHandle.standardError.write(Data("[openwhispr-coreaudio-tap] \(message)\n".utf8))
}

private func appendLE(_ value: UInt32, to data: inout Data) {
  var littleEndian = value.littleEndian
  withUnsafeBytes(of: &littleEndian) { data.append(contentsOf: $0) }
}

private func writeOwhaPacket(stereo: [Float], sampleRate: UInt32) {
  let frameCount = stereo.count / 2
  guard frameCount > 0 else { return }
  var packet = Data(capacity: 20 + stereo.count * MemoryLayout<Float>.size)
  packet.append(magic)
  appendLE(protocolVersion, to: &packet)
  appendLE(sampleRate, to: &packet)
  appendLE(2, to: &packet)
  appendLE(UInt32(frameCount), to: &packet)
  stereo.withUnsafeBufferPointer { buffer in
    let raw = UnsafeRawBufferPointer(buffer)
    packet.append(contentsOf: raw)
  }
  FileHandle.standardOutput.write(packet)
}

private func parseTestSeconds() -> Double? {
  let args = CommandLine.arguments
  guard let idx = args.firstIndex(of: "--test-rms"), idx + 1 < args.count else {
    return nil
  }
  return Double(args[idx + 1])
}

private func propertyAddress(_ selector: AudioObjectPropertySelector) -> AudioObjectPropertyAddress {
  AudioObjectPropertyAddress(
    mSelector: selector,
    mScope: kAudioObjectPropertyScopeGlobal,
    mElement: kAudioObjectPropertyElementMain
  )
}

private func readDefaultSystemOutputDeviceID() throws -> AudioObjectID {
  var address = AudioObjectPropertyAddress(
    mSelector: kAudioHardwarePropertyDefaultSystemOutputDevice,
    mScope: kAudioObjectPropertyScopeGlobal,
    mElement: kAudioObjectPropertyElementMain
  )
  var deviceID = AudioObjectID(kAudioObjectUnknown)
  var size = UInt32(MemoryLayout<AudioObjectID>.size)
  let st = AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &deviceID)
  guard st == noErr else { throw TapErr.os("DefaultSystemOutputDevice", st) }
  return deviceID
}

private func readDeviceUIDString(deviceID: AudioObjectID) throws -> String {
  var address = AudioObjectPropertyAddress(
    mSelector: kAudioDevicePropertyDeviceUID,
    mScope: kAudioObjectPropertyScopeGlobal,
    mElement: kAudioObjectPropertyElementMain
  )
  var dataSize: UInt32 = 0
  var st = AudioObjectGetPropertyDataSize(deviceID, &address, 0, nil, &dataSize)
  guard st == noErr else { throw TapErr.os("DeviceUID-size", st) }
  var cfName: CFString = "" as CFString
  st = withUnsafeMutablePointer(to: &cfName) { ptr in
    var sz = dataSize
    return AudioObjectGetPropertyData(deviceID, &address, 0, nil, &sz, ptr)
  }
  guard st == noErr else { throw TapErr.os("DeviceUID", st) }
  return cfName as String
}

private func deliverABLToTapContext(
  _ io: TapIOContext,
  _ inInputData: UnsafePointer<AudioBufferList>,
  format: AudioStreamBasicDescription
) {
  let abl = UnsafeMutableAudioBufferListPointer(UnsafeMutablePointer(mutating: inInputData))
  guard format.mFormatID == kAudioFormatLinearPCM else { return }
  guard (format.mFormatFlags & kAudioFormatFlagIsFloat) != 0 else { return }
  let channels = Int(format.mChannelsPerFrame)
  guard channels >= 1 else { return }
  let nonInterleaved = (format.mFormatFlags & kAudioFormatFlagIsNonInterleaved) != 0

  if !nonInterleaved, abl.count >= 1, let mData = abl[0].mData {
    let bpf = Int(format.mBytesPerFrame)
    guard bpf > 0 else { return }
    let byteSize = Int(abl[0].mDataByteSize)
    let frames = byteSize / bpf
    guard frames > 0 else { return }
    let floatPtr = mData.assumingMemoryBound(to: Float.self)
    if channels == 2 {
      io.handleInputFrames(floatPtr, frameCount: frames)
    }
    return
  }

  guard channels == 2, abl.count >= 2, let p0 = abl[0].mData, let p1 = abl[1].mData else { return }
  let ch0Bytes = Int(abl[0].mDataByteSize)
  let frameCount = ch0Bytes / MemoryLayout<Float>.size
  guard frameCount > 0 else { return }
  let f0 = p0.assumingMemoryBound(to: Float.self)
  let f1 = p1.assumingMemoryBound(to: Float.self)
  var stereo = [Float](repeating: 0, count: frameCount * 2)
  for i in 0..<frameCount {
    stereo[i * 2] = f0[i]
    stereo[i * 2 + 1] = f1[i]
  }
  stereo.withUnsafeBufferPointer { buf in
    io.handleInputFrames(buf.baseAddress!, frameCount: frameCount)
  }
}

private final class AudioStats {
  private let lock = NSLock()
  private var sumSquares: Double = 0
  private var sampleCount: Int = 0
  private var peakValue: Float = 0

  func addInterleavedStereo(_ data: UnsafePointer<Float>, frameCount: Int) {
    lock.lock()
    defer { lock.unlock() }
    let n = frameCount * 2
    for i in 0..<n {
      let sample = data[i]
      let absolute = abs(sample)
      if absolute > peakValue { peakValue = absolute }
      sumSquares += Double(sample * sample)
      sampleCount += 1
    }
  }

  func snapshot() -> (rms: Double, peak: Float, sampleCount: Int) {
    lock.lock()
    defer { lock.unlock() }
    let rms = sampleCount > 0 ? sqrt(sumSquares / Double(sampleCount)) : 0
    return (rms, peakValue, sampleCount)
  }
}

private final class TapIOContext {
  let stats = AudioStats()
  var streamStdout = false
  var firstAudio = false
  var sampleRate: UInt32 = 48_000

  func handleInputFrames(_ data: UnsafePointer<Float>, frameCount: Int) {
    stats.addInterleavedStereo(data, frameCount: frameCount)
    if streamStdout {
      let n = frameCount * 2
      let stereo = Array(UnsafeBufferPointer(start: data, count: n))
      writeOwhaPacket(stereo: stereo, sampleRate: sampleRate)
    }
    if !firstAudio {
      firstAudio = true
      log("first-audio-sample")
    }
  }
}

private enum TapErr: Error {
  case os(String, OSStatus)
}

@available(macOS 14.2, *)
private final class CoreAudioTapSession {
  private var tapID: AudioObjectID = kAudioObjectUnknown
  private var aggregateID: AudioObjectID = kAudioObjectUnknown
  private var deviceProcID: AudioDeviceIOProcID?
  private let ioCtx = TapIOContext()
  private let ioQueue = DispatchQueue(label: "openwhispr-coreaudio-tap.io", qos: .userInteractive)
  private var tapStreamFormat = AudioStreamBasicDescription()

  func run(streamStdout: Bool, testSeconds: Double?) throws {
    ioCtx.streamStdout = streamStdout

    let exclude: [AudioObjectID] = []
    let tapDescription = CATapDescription(stereoGlobalTapButExcludeProcesses: exclude)
    tapDescription.uuid = UUID()
    tapDescription.name = "openwhispr-coreaudio-tap"
    tapDescription.isPrivate = false
    tapDescription.isMixdown = true
    tapDescription.isMono = false

    var tid = kAudioObjectUnknown
    var st = AudioHardwareCreateProcessTap(tapDescription, &tid)
    guard st == noErr else { throw TapErr.os("AudioHardwareCreateProcessTap", st) }
    tapID = tid
    log("tap-created id=\(tapID)")

    var fmtAddr = propertyAddress(kAudioTapPropertyFormat)
    var fmtSize = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
    st = AudioObjectGetPropertyData(tapID, &fmtAddr, 0, nil, &fmtSize, &tapStreamFormat)
    guard st == noErr else { throw TapErr.os("kAudioTapPropertyFormat", st) }
    ioCtx.sampleRate = UInt32(tapStreamFormat.mSampleRate.rounded())
    log(String(format: "tap-format: sr=%.0f ch=%u flags=0x%x", tapStreamFormat.mSampleRate, tapStreamFormat.mChannelsPerFrame, tapStreamFormat.mFormatFlags))

    let systemOutputID = try readDefaultSystemOutputDeviceID()
    let outputUID = try readDeviceUIDString(deviceID: systemOutputID)
    log("system-output-device uid=\(outputUID)")

    let aggregateUID = UUID().uuidString
    let subTapUID = tapDescription.uuid.uuidString

    let aggDesc: [String: Any] = [
      kAudioAggregateDeviceNameKey as String: "OpenwhisprTapAggregate",
      kAudioAggregateDeviceUIDKey as String: aggregateUID,
      kAudioAggregateDeviceMainSubDeviceKey as String: outputUID,
      kAudioAggregateDeviceIsPrivateKey as String: true,
      kAudioAggregateDeviceIsStackedKey as String: false,
      kAudioAggregateDeviceTapAutoStartKey as String: true,
      kAudioAggregateDeviceSubDeviceListKey as String: [
        [kAudioSubDeviceUIDKey as String: outputUID]
      ],
      kAudioAggregateDeviceTapListKey as String: [
        [
          kAudioSubTapDriftCompensationKey as String: true,
          kAudioSubTapUIDKey as String: subTapUID
        ]
      ]
    ]

    var aid: AudioObjectID = 0
    st = AudioHardwareCreateAggregateDevice(aggDesc as CFDictionary, &aid)
    guard st == noErr else { throw TapErr.os("AudioHardwareCreateAggregateDevice", st) }
    aggregateID = aid
    log("aggregate-created id=\(aggregateID) tapListUUID=\(subTapUID)")

    let tapFormatCopy = tapStreamFormat
    let ctx = ioCtx
    st = AudioDeviceCreateIOProcIDWithBlock(&deviceProcID, aggregateID, ioQueue) { _, inInputData, _, _, _ in
      deliverABLToTapContext(ctx, inInputData, format: tapFormatCopy)
    }
    guard st == noErr else { throw TapErr.os("AudioDeviceCreateIOProcIDWithBlock", st) }

    st = AudioDeviceStart(aggregateID, deviceProcID)
    guard st == noErr else { throw TapErr.os("AudioDeviceStart", st) }
    log("capture-start: AudioDeviceStart ok aggregate=\(aggregateID)")

    if let testSeconds {
      let deadline = Date().addingTimeInterval(testSeconds)
      while Date() < deadline {
        Thread.sleep(forTimeInterval: 0.1)
        if Date().timeIntervalSince1970.truncatingRemainder(dividingBy: 1) < 0.11 {
          let s = ioCtx.stats.snapshot()
          log(String(format: "test-rms rms=%.6f peak=%.6f samples=%d", s.rms, s.peak, s.sampleCount))
        }
      }
      let final = ioCtx.stats.snapshot()
      log(String(format: "test-rms-final rms=%.6f peak=%.6f samples=%d", final.rms, final.peak, final.sampleCount))
      try teardown()
      Foundation.exit(final.rms > 0 || final.peak > 0.01 ? 0 : 4)
    }

    dispatchMain()
  }

  func teardown() throws {
    if aggregateID != kAudioObjectUnknown, let proc = deviceProcID {
      var err = AudioDeviceStop(aggregateID, proc)
      if err != noErr { log("AudioDeviceStop err=\(err)") }
      err = AudioDeviceDestroyIOProcID(aggregateID, proc)
      if err != noErr { log("AudioDeviceDestroyIOProcID err=\(err)") }
      deviceProcID = nil
    }
    if aggregateID != kAudioObjectUnknown {
      _ = AudioHardwareDestroyAggregateDevice(aggregateID)
      aggregateID = kAudioObjectUnknown
    }
    if tapID != kAudioObjectUnknown {
      _ = AudioHardwareDestroyProcessTap(tapID)
      tapID = kAudioObjectUnknown
    }
  }
}

@main
enum OpenwhisprCoreAudioTapHelper {
  static func main() {
    let args = CommandLine.arguments
    if args.contains("--check") {
      log("check: ok (openwhispr-coreaudio-tap-helper built; requires macOS 14.2+ and system audio capture entitlement when run from an app)")
      Foundation.exit(0)
    }

    let testSeconds = parseTestSeconds()
    let streamStdout = testSeconds == nil

    if #available(macOS 14.2, *) {
      let session = CoreAudioTapSession()
      do {
        try session.run(streamStdout: streamStdout, testSeconds: testSeconds)
      } catch {
        log("fatal: \(error)")
        Foundation.exit(2)
      }
    } else {
      log("CoreAudio Tap requires macOS 14.2 or newer")
      Foundation.exit(6)
    }
  }
}
