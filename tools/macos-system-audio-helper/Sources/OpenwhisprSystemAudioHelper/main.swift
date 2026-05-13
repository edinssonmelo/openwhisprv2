import AVFoundation
import CoreGraphics
import CoreMedia
import Foundation
@preconcurrency import ScreenCaptureKit

private let magic = Data([0x4f, 0x57, 0x48, 0x41]) // OWHA
private let protocolVersion: UInt32 = 1

private func log(_ message: String) {
    FileHandle.standardError.write(Data("[openwhispr-audio-helper] \(message)\n".utf8))
}

private func appendLE(_ value: UInt32, to data: inout Data) {
    var littleEndian = value.littleEndian
    withUnsafeBytes(of: &littleEndian) { data.append(contentsOf: $0) }
}

private func parseTestSeconds() -> Double? {
    let args = CommandLine.arguments
    guard let idx = args.firstIndex(of: "--test-rms"), idx + 1 < args.count else {
        return nil
    }
    return Double(args[idx + 1])
}

private final class StartFlag: @unchecked Sendable {
    private let lock = NSLock()
    private var value = false

    func set() {
        lock.lock()
        value = true
        lock.unlock()
    }

    func get() -> Bool {
        lock.lock()
        defer { lock.unlock() }
        return value
    }
}

private final class AudioStats {
    private let lock = NSLock()
    private var sumSquares: Double = 0
    private var sampleCount: Int = 0
    private var peakValue: Float = 0

    func add(samples: [Float]) {
        lock.lock()
        defer { lock.unlock() }
        for sample in samples {
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

private final class ScreenSink: NSObject, SCStreamOutput {
    private let firstLock = NSLock()
    private var loggedFirst = false

    func stream(
        _ stream: SCStream,
        didOutputSampleBuffer sampleBuffer: CMSampleBuffer,
        of outputType: SCStreamOutputType
    ) {
        guard outputType == .screen else { return }
        firstLock.lock()
        let shouldLog = !loggedFirst
        if shouldLog { loggedFirst = true }
        firstLock.unlock()
        if shouldLog {
            log("first-screen-sample")
        }
    }
}

private final class SystemAudioOutput: NSObject, SCStreamOutput {
    private let streamStdout: Bool
    private let stats: AudioStats
    private var chunkCount = 0

    init(streamStdout: Bool, stats: AudioStats) {
        self.streamStdout = streamStdout
        self.stats = stats
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of outputType: SCStreamOutputType) {
        guard outputType == .audio else { return }
        guard CMSampleBufferIsValid(sampleBuffer), CMSampleBufferDataIsReady(sampleBuffer) else { return }
        guard let formatDescription = CMSampleBufferGetFormatDescription(sampleBuffer),
              let streamDescription = CMAudioFormatDescriptionGetStreamBasicDescription(formatDescription)?.pointee else {
            log("audio sample missing format description")
            return
        }

        let frameCount = CMSampleBufferGetNumSamples(sampleBuffer)
        guard frameCount > 0 else { return }

        guard let stereo = copyStereoFloat32(sampleBuffer: sampleBuffer, asbd: streamDescription, frameCount: frameCount) else {
            return
        }

        stats.add(samples: stereo)
        chunkCount += 1

        if chunkCount == 1 {
            log("first-audio-sample")
        }

        guard streamStdout else { return }

        var packet = Data(capacity: 20 + stereo.count * MemoryLayout<Float>.size)
        packet.append(magic)
        appendLE(protocolVersion, to: &packet)
        appendLE(UInt32(streamDescription.mSampleRate.rounded()), to: &packet)
        appendLE(2, to: &packet)
        appendLE(UInt32(frameCount), to: &packet)
        stereo.withUnsafeBufferPointer { buffer in
            let raw = UnsafeRawBufferPointer(buffer)
            packet.append(contentsOf: raw)
        }
        FileHandle.standardOutput.write(packet)
    }

    private func copyStereoFloat32(
        sampleBuffer: CMSampleBuffer,
        asbd: AudioStreamBasicDescription,
        frameCount: Int
    ) -> [Float]? {
        let sourceChannels = max(1, Int(asbd.mChannelsPerFrame))
        let isFloat = (asbd.mFormatFlags & kAudioFormatFlagIsFloat) != 0
        let isSignedInteger = (asbd.mFormatFlags & kAudioFormatFlagIsSignedInteger) != 0
        let isNonInterleaved = (asbd.mFormatFlags & kAudioFormatFlagIsNonInterleaved) != 0
        let bits = Int(asbd.mBitsPerChannel)

        guard (isFloat && bits == 32) || (isSignedInteger && bits == 16) else {
            log("unsupported audio format flags=\(asbd.mFormatFlags) bits=\(bits) channels=\(sourceChannels)")
            return nil
        }

        let bufferCount = isNonInterleaved ? sourceChannels : 1
        let bytesPerSample = bits / 8
        let bytesPerBuffer = isNonInterleaved
            ? frameCount * bytesPerSample
            : frameCount * sourceChannels * bytesPerSample

        let audioBufferListSize = MemoryLayout<AudioBufferList>.size + MemoryLayout<AudioBuffer>.size * max(0, bufferCount - 1)
        let audioBufferListRaw = UnsafeMutableRawPointer.allocate(
            byteCount: audioBufferListSize,
            alignment: MemoryLayout<AudioBufferList>.alignment
        )
        defer { audioBufferListRaw.deallocate() }

        let audioBufferList = audioBufferListRaw.assumingMemoryBound(to: AudioBufferList.self)
        audioBufferList.pointee.mNumberBuffers = UInt32(bufferCount)
        let buffers = UnsafeMutableAudioBufferListPointer(audioBufferList)
        var allocatedData: [UnsafeMutableRawPointer] = []
        allocatedData.reserveCapacity(bufferCount)
        defer {
            for pointer in allocatedData {
                pointer.deallocate()
            }
        }

        for index in 0..<bufferCount {
            let pointer = UnsafeMutableRawPointer.allocate(byteCount: bytesPerBuffer, alignment: MemoryLayout<Float>.alignment)
            pointer.initializeMemory(as: UInt8.self, repeating: 0, count: bytesPerBuffer)
            allocatedData.append(pointer)
            buffers[index].mNumberChannels = isNonInterleaved ? 1 : UInt32(sourceChannels)
            buffers[index].mDataByteSize = UInt32(bytesPerBuffer)
            buffers[index].mData = pointer
        }

        let status = CMSampleBufferCopyPCMDataIntoAudioBufferList(
            sampleBuffer,
            at: 0,
            frameCount: Int32(frameCount),
            into: audioBufferList
        )
        guard status == noErr else {
            log("CMSampleBufferCopyPCMDataIntoAudioBufferList failed status=\(status)")
            return nil
        }

        var stereo = [Float](repeating: 0, count: frameCount * 2)

        if isFloat {
            if isNonInterleaved {
                let left = buffers[0].mData!.assumingMemoryBound(to: Float.self)
                let right = sourceChannels > 1 ? buffers[1].mData!.assumingMemoryBound(to: Float.self) : left
                for frame in 0..<frameCount {
                    stereo[frame * 2] = left[frame]
                    stereo[frame * 2 + 1] = right[frame]
                }
            } else {
                let interleaved = buffers[0].mData!.assumingMemoryBound(to: Float.self)
                for frame in 0..<frameCount {
                    let base = frame * sourceChannels
                    stereo[frame * 2] = interleaved[base]
                    stereo[frame * 2 + 1] = sourceChannels > 1 ? interleaved[base + 1] : interleaved[base]
                }
            }
            return stereo
        }

        if isNonInterleaved {
            let left = buffers[0].mData!.assumingMemoryBound(to: Int16.self)
            let right = sourceChannels > 1 ? buffers[1].mData!.assumingMemoryBound(to: Int16.self) : left
            for frame in 0..<frameCount {
                stereo[frame * 2] = Float(left[frame]) / 32768.0
                stereo[frame * 2 + 1] = Float(right[frame]) / 32768.0
            }
        } else {
            let interleaved = buffers[0].mData!.assumingMemoryBound(to: Int16.self)
            for frame in 0..<frameCount {
                let base = frame * sourceChannels
                stereo[frame * 2] = Float(interleaved[base]) / 32768.0
                stereo[frame * 2 + 1] = sourceChannels > 1 ? Float(interleaved[base + 1]) / 32768.0 : Float(interleaved[base]) / 32768.0
            }
        }
        return stereo
    }
}

private final class StreamDelegate: NSObject, SCStreamDelegate {
    func stream(_ stream: SCStream, didStopWithError error: Error) {
        log("stream stopped with error: \(error)")
        Foundation.exit(3)
    }
}

private final class HelperRunner {
    private let stats = AudioStats()
    private let screenQueue = DispatchQueue(label: "openwhispr.system-audio.screen")
    private let audioQueue = DispatchQueue(label: "openwhispr.system-audio.audio")

    private var stream: SCStream?
    private var delegate: StreamDelegate?
    private var audioOutput: SystemAudioOutput?
    private var screenOutput: ScreenSink?

    func start(streamStdout: Bool) async throws {
        let pre = CGPreflightScreenCaptureAccess()
        log("screen-permission: preflight=\(pre ? "granted" : "not-granted")")
        if !pre {
            let requested = CGRequestScreenCaptureAccess()
            log("screen-permission: requested result=\(requested ? "granted" : "denied-or-pending")")
        }

        log("requesting ScreenCaptureKit shareable content")
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        let mainId = CGMainDisplayID()
        let display = content.displays.first(where: { $0.displayID == mainId })
            ?? content.displays.first
        guard let display else {
            throw NSError(domain: "OpenwhisprSystemAudioHelper", code: 10, userInfo: [NSLocalizedDescriptionKey: "No capturable display found"])
        }
        log("selected display=\(display.displayID) mainDisplayID=\(mainId) displays=\(content.displays.count)")

        let filter = SCContentFilter(display: display, excludingWindows: [])
        let configuration = SCStreamConfiguration()
        configuration.capturesAudio = true
        configuration.excludesCurrentProcessAudio = true
        configuration.sampleRate = 48_000
        configuration.channelCount = 2

        let fw = Int(display.frame.width.rounded())
        let fh = Int(display.frame.height.rounded())
        if fw > 0 && fh > 0 {
            configuration.width = max(640, fw)
            configuration.height = max(360, fh)
        } else {
            configuration.width = 1280
            configuration.height = 720
        }
        configuration.minimumFrameInterval = CMTime(value: 1, timescale: 15)
        configuration.queueDepth = 5
        configuration.showsCursor = false

        let streamDelegate = StreamDelegate()
        let scStream = SCStream(filter: filter, configuration: configuration, delegate: streamDelegate)

        let screenSink = ScreenSink()
        let audioSink = SystemAudioOutput(streamStdout: streamStdout, stats: stats)

        self.delegate = streamDelegate
        self.screenOutput = screenSink
        self.audioOutput = audioSink
        self.stream = scStream

        try scStream.addStreamOutput(screenSink, type: .screen, sampleHandlerQueue: screenQueue)
        let screenOutputRegistered = true
        try scStream.addStreamOutput(audioSink, type: .audio, sampleHandlerQueue: audioQueue)
        let audioOutputRegistered = true

        log("capture-start: called display=\(display.displayID) width=\(configuration.width) height=\(configuration.height) audio=true screenOutput=true")

        let startFlag = StartFlag()
        DispatchQueue.global().asyncAfter(deadline: .now() + 8) {
            if !startFlag.get() {
                log("SCK_START_TIMEOUT preflight=\(pre ? "granted" : "not-granted") display=\(display.displayID) screenOutputRegistered=\(screenOutputRegistered) audioOutputRegistered=\(audioOutputRegistered) causes=no_screen_output_registered|invalid_stream_config|unsigned_cli|sck_internal_hang")
                Foundation.exit(5)
            }
        }

        try await Task { @MainActor in
            try await scStream.startCapture()
        }.value

        startFlag.set()
        log("capture-start: returned")
        log("capture started display=\(display.displayID) stdout=\(streamStdout)")
    }

    func stop() async {
        if let stream {
            try? await stream.stopCapture()
        }
        stream = nil
        delegate = nil
        audioOutput = nil
        screenOutput = nil
    }

    func snapshot() -> (rms: Double, peak: Float, sampleCount: Int) {
        stats.snapshot()
    }
}

@main
private struct OpenwhisprSystemAudioHelper {
    static func main() async {
        let testSeconds = parseTestSeconds()
        let runner = HelperRunner()

        do {
            try await runner.start(streamStdout: testSeconds == nil)
        } catch {
            log("failed to start ScreenCaptureKit audio: \(error)")
            Foundation.exit(2)
        }

        if let testSeconds {
            let deadline = Date().addingTimeInterval(testSeconds)
            var lastPrint = Date()
            while Date() < deadline {
                try? await Task.sleep(nanoseconds: 100_000_000)
                if Date().timeIntervalSince(lastPrint) >= 1 {
                    lastPrint = Date()
                    let sample = runner.snapshot()
                    log(String(format: "test-rms rms=%.6f peak=%.6f samples=%d", sample.rms, sample.peak, sample.sampleCount))
                }
            }
            let final = runner.snapshot()
            log(String(format: "test-rms-final rms=%.6f peak=%.6f samples=%d", final.rms, final.peak, final.sampleCount))
            await runner.stop()
            Foundation.exit(final.rms > 0.003 || final.peak > 0.01 ? 0 : 4)
        }

        dispatchMain()
    }
}
