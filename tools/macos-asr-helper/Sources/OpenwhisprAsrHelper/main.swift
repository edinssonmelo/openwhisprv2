// Openwhispr ASR helper: Parakeet TDT 0.6B v3 (FluidAudio, Core ML / Apple Neural Engine).
//
// Protocol (see electron/asr/protocol.ts for the TypeScript mirror):
//   stdin  — binary frames: "OWAS" | u32le headerLength | header JSON (UTF-8) | u32le payloadLength | payload
//            header.type: "transcribe" (payload = float32le mono PCM), "cancel", "ping", "shutdown"
//   stdout — NDJSON events: ready, progress, result, error, dropped, pong, log, fatal
//
// CLI:
//   --serve --model-dir <dir>                   protocol mode (default)
//   --check --model-dir <dir>                   JSON status of models on disk, exit
//   --download --model-dir <dir>                download models (progress as NDJSON), exit
//   --transcribe-file <wav> --model-dir <dir> [--language en|es|auto]   one-shot transcription, JSON, exit

import AVFoundation
import FluidAudio
import Foundation

let helperVersion = "1.0.0"
let engineName = "parakeet-tdt-0.6b-v3"
let targetSampleRate = 16_000
let frameMagic: [UInt8] = Array("OWAS".utf8)
/// Parakeet rejects < 300 ms; pad short fragments so previews of 1 word still decode.
let minimumSamplesForDecode = targetSampleRate  // 1 s

// MARK: - Output

final class OutputWriter: @unchecked Sendable {
  private let queue = DispatchQueue(label: "openwhispr.asr-helper.output")
  private let handle = FileHandle.standardOutput

  func emit(_ object: [String: Any]) {
    guard JSONSerialization.isValidJSONObject(object),
      let data = try? JSONSerialization.data(withJSONObject: object)
    else { return }
    queue.sync {
      handle.write(data)
      handle.write(Data([0x0A]))
    }
  }
}

let output = OutputWriter()

func emitLog(_ level: String, _ message: String) {
  output.emit(["type": "log", "level": level, "message": message])
}

func nowMs() -> Double {
  Date().timeIntervalSince1970 * 1000
}

// MARK: - CLI

struct CliOptions {
  var mode: String = "serve"
  var modelDir: URL?
  var filePath: String?
  var language: String = "auto"
}

func parseCli() -> CliOptions {
  var options = CliOptions()
  var iterator = CommandLine.arguments.dropFirst().makeIterator()
  while let argument = iterator.next() {
    switch argument {
    case "--serve": options.mode = "serve"
    case "--check": options.mode = "check"
    case "--download": options.mode = "download"
    case "--transcribe-file":
      options.mode = "file"
      options.filePath = iterator.next()
    case "--model-dir":
      if let value = iterator.next() { options.modelDir = URL(fileURLWithPath: value) }
    case "--language":
      if let value = iterator.next() { options.language = value }
    default:
      emitLog("warn", "Unknown argument: \(argument)")
    }
  }
  return options
}

func languageHint(_ code: String?) -> Language? {
  switch code?.lowercased() {
  case "en": return .english
  case "es": return .spanish
  default: return nil
  }
}

// MARK: - Audio utilities

func resampleToTarget(_ samples: [Float], from sampleRate: Int) -> [Float] {
  guard sampleRate != targetSampleRate, !samples.isEmpty else { return samples }
  guard
    let inputFormat = AVAudioFormat(
      commonFormat: .pcmFormatFloat32, sampleRate: Double(sampleRate), channels: 1, interleaved: false),
    let outputFormat = AVAudioFormat(
      commonFormat: .pcmFormatFloat32, sampleRate: Double(targetSampleRate), channels: 1, interleaved: false),
    let converter = AVAudioConverter(from: inputFormat, to: outputFormat),
    let inputBuffer = AVAudioPCMBuffer(pcmFormat: inputFormat, frameCapacity: AVAudioFrameCount(samples.count))
  else {
    return linearResample(samples, from: sampleRate)
  }
  inputBuffer.frameLength = AVAudioFrameCount(samples.count)
  samples.withUnsafeBufferPointer { pointer in
    inputBuffer.floatChannelData![0].update(from: pointer.baseAddress!, count: samples.count)
  }
  let ratio = Double(targetSampleRate) / Double(sampleRate)
  let capacity = AVAudioFrameCount(Double(samples.count) * ratio) + 64
  guard let outputBuffer = AVAudioPCMBuffer(pcmFormat: outputFormat, frameCapacity: capacity) else {
    return linearResample(samples, from: sampleRate)
  }
  var consumed = false
  var conversionError: NSError?
  let status = converter.convert(to: outputBuffer, error: &conversionError) { _, outStatus in
    if consumed {
      outStatus.pointee = .endOfStream
      return nil
    }
    consumed = true
    outStatus.pointee = .haveData
    return inputBuffer
  }
  if status == .error || conversionError != nil {
    return linearResample(samples, from: sampleRate)
  }
  let count = Int(outputBuffer.frameLength)
  return Array(UnsafeBufferPointer(start: outputBuffer.floatChannelData![0], count: count))
}

func linearResample(_ samples: [Float], from sampleRate: Int) -> [Float] {
  let ratio = Double(sampleRate) / Double(targetSampleRate)
  let outCount = Int(Double(samples.count) / ratio)
  var out = [Float](repeating: 0, count: max(outCount, 0))
  for index in 0..<out.count {
    let position = Double(index) * ratio
    let base = Int(position)
    let fraction = Float(position - Double(base))
    let next = min(base + 1, samples.count - 1)
    out[index] = samples[base] * (1 - fraction) + samples[next] * fraction
  }
  return out
}

func padForDecode(_ samples: [Float]) -> [Float] {
  guard samples.count < minimumSamplesForDecode else { return samples }
  return samples + [Float](repeating: 0, count: minimumSamplesForDecode - samples.count)
}

func loadWavAsMono16k(_ path: String) throws -> [Float] {
  let file = try AVAudioFile(forReading: URL(fileURLWithPath: path))
  let format = file.processingFormat
  guard let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(file.length)) else {
    throw NSError(domain: "openwhispr.asr-helper", code: 1, userInfo: [NSLocalizedDescriptionKey: "Cannot allocate WAV buffer"])
  }
  try file.read(into: buffer)
  let channels = Int(format.channelCount)
  let frames = Int(buffer.frameLength)
  var mono = [Float](repeating: 0, count: frames)
  if let floatData = buffer.floatChannelData {
    for channel in 0..<channels {
      let pointer = floatData[channel]
      for frame in 0..<frames { mono[frame] += pointer[frame] }
    }
  } else if let intData = buffer.int16ChannelData {
    for channel in 0..<channels {
      let pointer = intData[channel]
      for frame in 0..<frames { mono[frame] += Float(pointer[frame]) / 32768 }
    }
  }
  if channels > 1 {
    let scale = 1 / Float(channels)
    for frame in 0..<frames { mono[frame] *= scale }
  }
  return resampleToTarget(mono, from: Int(format.sampleRate))
}

// MARK: - Engine

struct EngineStatus {
  let modelsPresent: Bool
  let modelDir: URL
}

actor ParakeetEngine {
  private let manager = AsrManager(config: .default)
  private var loaded = false
  private(set) var loadMs: Double = 0
  private var decoderLayers = 2

  func status(modelDir: URL) -> EngineStatus {
    EngineStatus(
      modelsPresent: AsrModels.modelsExist(at: modelDir, version: .v3, encoderPrecision: .int8),
      modelDir: modelDir)
  }

  /// FluidAudio owns the on-disk layout under `modelDir`'s parent (per-file revision cache: a killed download
  /// is detected as missing files and resumed on the next run), so we only orchestrate and report progress.
  func ensureModels(modelDir: URL, progress: @escaping @Sendable (Double, String) -> Void) async throws {
    if AsrModels.modelsExist(at: modelDir, version: .v3, encoderPrecision: .int8) { return }
    try FileManager.default.createDirectory(
      at: modelDir.deletingLastPathComponent(), withIntermediateDirectories: true)
    _ = try await AsrModels.download(
      to: modelDir, version: .v3, encoderPrecision: .int8,
      progressHandler: { update in
        progress(update.fractionCompleted, "\(update.phase)")
      })
    guard AsrModels.modelsExist(at: modelDir, version: .v3, encoderPrecision: .int8) else {
      throw NSError(
        domain: "openwhispr.asr-helper", code: 2,
        userInfo: [NSLocalizedDescriptionKey: "Models missing after download at \(modelDir.path)"])
    }
  }

  func load(modelDir: URL) async throws {
    guard !loaded else { return }
    let startedAt = nowMs()
    let models = try await AsrModels.load(from: modelDir, version: .v3, encoderPrecision: .int8)
    try await manager.loadModels(models)
    decoderLayers = models.version.decoderLayers
    loaded = true
    loadMs = nowMs() - startedAt
  }

  func transcribe(samples: [Float], language: Language?) async throws -> ASRResult {
    guard loaded else { throw ASRError.notInitialized }
    var state = try TdtDecoderState(decoderLayers: decoderLayers)
    return try await manager.transcribe(padForDecode(samples), decoderState: &state, language: language)
  }
}

// MARK: - Requests

struct TranscribeRequest {
  let requestId: String
  let sessionId: String
  let generation: Int
  let source: String
  let segmentId: String
  let kind: String
  let sampleRate: Int
  let startMs: Double
  let endMs: Double
  let language: String?
  let samples: [Float]
  let receivedAtMs: Double

  var previewKey: String { "\(sessionId)|\(source)|\(segmentId)" }
}

/// Finals run before previews. A newer preview for the same segment replaces the queued one (replace-only semantics).
actor RequestQueue {
  private var finals: [TranscribeRequest] = []
  private var previews: [TranscribeRequest] = []
  private var waiter: CheckedContinuation<TranscribeRequest?, Never>?
  private var closed = false

  /// Returns requestIds dropped because they were superseded.
  func enqueue(_ request: TranscribeRequest) -> [String] {
    var dropped: [String] = []
    if request.kind == "final" {
      finals.append(request)
    } else {
      previews.removeAll { existing in
        if existing.previewKey == request.previewKey {
          dropped.append(existing.requestId)
          return true
        }
        return false
      }
      previews.append(request)
    }
    wake()
    return dropped
  }

  func cancel(requestIds: [String]) -> [String] {
    let ids = Set(requestIds)
    let dropped = (finals + previews).map(\.requestId).filter { ids.contains($0) }
    finals.removeAll { ids.contains($0.requestId) }
    previews.removeAll { ids.contains($0.requestId) }
    return dropped
  }

  func cancelPreviews(sessionId: String?) -> [String] {
    var dropped: [String] = []
    previews.removeAll { request in
      if sessionId == nil || request.sessionId == sessionId {
        dropped.append(request.requestId)
        return true
      }
      return false
    }
    return dropped
  }

  func close() {
    closed = true
    wake()
  }

  var pendingCount: Int { finals.count + previews.count }

  func next() async -> TranscribeRequest? {
    if let request = popNext() { return request }
    if closed { return nil }
    return await withCheckedContinuation { continuation in
      waiter = continuation
    }
  }

  private func popNext() -> TranscribeRequest? {
    if !finals.isEmpty { return finals.removeFirst() }
    if !previews.isEmpty { return previews.removeFirst() }
    return nil
  }

  private func wake() {
    guard let continuation = waiter else { return }
    if let request = popNext() {
      waiter = nil
      continuation.resume(returning: request)
    } else if closed {
      waiter = nil
      continuation.resume(returning: nil)
    }
  }
}

// MARK: - Frame parsing

final class FrameParser {
  private var buffer: [UInt8] = []
  private var readOffset = 0

  struct Frame {
    let header: [String: Any]
    let payload: [UInt8]
  }

  func append(_ data: Data) -> [Frame] {
    buffer.append(contentsOf: data)
    var frames: [Frame] = []
    while true {
      let available = buffer.count - readOffset
      guard available >= 8 else { break }
      let base = readOffset
      let magicMatches =
        buffer[base] == frameMagic[0] && buffer[base + 1] == frameMagic[1] && buffer[base + 2] == frameMagic[2]
        && buffer[base + 3] == frameMagic[3]
      if !magicMatches {
        // Resync: skip one byte at a time until a magic is found.
        readOffset += 1
        continue
      }
      let headerLength = Int(readUInt32LE(at: base + 4))
      guard available >= 8 + headerLength + 4 else { break }
      let payloadLength = Int(readUInt32LE(at: base + 8 + headerLength))
      let total = 8 + headerLength + 4 + payloadLength
      guard available >= total else { break }
      let headerBytes = Array(buffer[(base + 8)..<(base + 8 + headerLength)])
      let payload = Array(buffer[(base + 8 + headerLength + 4)..<(base + total)])
      readOffset += total
      if let object = try? JSONSerialization.jsonObject(with: Data(headerBytes)) as? [String: Any] {
        frames.append(Frame(header: object, payload: payload))
      } else {
        emitLog("warn", "Discarded frame with invalid JSON header (\(headerLength) bytes)")
      }
    }
    // Compact consumed bytes.
    if readOffset > 0 {
      if readOffset >= buffer.count {
        buffer.removeAll(keepingCapacity: true)
      } else if readOffset > 1_000_000 || readOffset * 2 > buffer.count {
        buffer.removeFirst(readOffset)
      } else {
        return frames
      }
      readOffset = 0
    }
    return frames
  }

  private func readUInt32LE(at offset: Int) -> UInt32 {
    UInt32(buffer[offset]) | (UInt32(buffer[offset + 1]) << 8) | (UInt32(buffer[offset + 2]) << 16)
      | (UInt32(buffer[offset + 3]) << 24)
  }
}

func floatSamples(from payload: [UInt8]) -> [Float] {
  let count = payload.count / 4
  var samples = [Float](repeating: 0, count: count)
  payload.withUnsafeBytes { source in
    samples.withUnsafeMutableBytes { destination in
      destination.copyMemory(from: UnsafeRawBufferPointer(rebasing: source[0..<(count * 4)]))
    }
  }
  return samples
}

// MARK: - Modes

func defaultModelDir() -> URL {
  AsrModels.defaultCacheDirectory(for: .v3)
}

func runCheck(modelDir: URL) {
  let present = AsrModels.modelsExist(at: modelDir, version: .v3, encoderPrecision: .int8)
  output.emit([
    "type": "check",
    "ok": present,
    "modelsPresent": present,
    "modelDir": modelDir.path,
    "engine": engineName,
    "helperVersion": helperVersion,
  ])
  exit(present ? 0 : 3)
}

func runDownload(modelDir: URL) async {
  let engine = ParakeetEngine()
  do {
    try await engine.ensureModels(modelDir: modelDir) { fraction, phase in
      output.emit(["type": "progress", "stage": "download", "fraction": fraction, "phase": phase])
    }
    output.emit(["type": "downloaded", "modelDir": modelDir.path, "engine": engineName])
    exit(0)
  } catch {
    output.emit(["type": "fatal", "message": "Model download failed: \(error.localizedDescription)"])
    exit(2)
  }
}

func runFile(path: String, modelDir: URL, language: String) async {
  let engine = ParakeetEngine()
  do {
    try await engine.ensureModels(modelDir: modelDir) { fraction, phase in
      output.emit(["type": "progress", "stage": "download", "fraction": fraction, "phase": phase])
    }
    try await engine.load(modelDir: modelDir)
    let samples = try loadWavAsMono16k(path)
    let startedAt = nowMs()
    let result = try await engine.transcribe(samples: samples, language: languageHint(language))
    let processingMs = nowMs() - startedAt
    output.emit([
      "type": "result",
      "engine": engineName,
      "text": result.text,
      "confidence": Double(result.confidence),
      "audioMs": Double(samples.count) / Double(targetSampleRate) * 1000,
      "processingMs": processingMs,
      "loadMs": await engine.loadMs,
    ])
    exit(0)
  } catch {
    output.emit(["type": "fatal", "message": "Transcription failed: \(error.localizedDescription)"])
    exit(2)
  }
}

func runServe(modelDir: URL) async {
  let engine = ParakeetEngine()
  let queue = RequestQueue()

  do {
    try await engine.ensureModels(modelDir: modelDir) { fraction, phase in
      output.emit(["type": "progress", "stage": "download", "fraction": fraction, "phase": phase])
    }
    output.emit(["type": "progress", "stage": "load", "fraction": 0])
    try await engine.load(modelDir: modelDir)
  } catch {
    output.emit(["type": "fatal", "message": "Model load failed: \(error.localizedDescription)"])
    exit(2)
  }

  // Warm-up: first Core ML prediction compiles kernels and would otherwise land on the first real preview.
  let warmupStartedAt = nowMs()
  _ = try? await engine.transcribe(samples: [Float](repeating: 0, count: targetSampleRate * 2), language: nil)
  output.emit([
    "type": "ready",
    "engine": engineName,
    "helperVersion": helperVersion,
    "modelDir": modelDir.path,
    "loadMs": await engine.loadMs,
    "warmupMs": nowMs() - warmupStartedAt,
    "sampleRate": targetSampleRate,
  ])

  // Reader thread: stdin → frames → queue.
  let reader = Thread {
    let parser = FrameParser()
    let stdin = FileHandle.standardInput
    while true {
      let data = stdin.availableData
      if data.isEmpty {
        Task { await queue.close() }
        return
      }
      for frame in parser.append(data) {
        let type = frame.header["type"] as? String ?? ""
        switch type {
        case "transcribe":
          let sampleRate = frame.header["sampleRate"] as? Int ?? targetSampleRate
          let request = TranscribeRequest(
            requestId: frame.header["requestId"] as? String ?? UUID().uuidString,
            sessionId: frame.header["sessionId"] as? String ?? "",
            generation: frame.header["generation"] as? Int ?? 0,
            source: frame.header["source"] as? String ?? "mic",
            segmentId: frame.header["segmentId"] as? String ?? "",
            kind: frame.header["kind"] as? String ?? "final",
            sampleRate: sampleRate,
            startMs: frame.header["startMs"] as? Double ?? 0,
            endMs: frame.header["endMs"] as? Double ?? 0,
            language: frame.header["language"] as? String,
            samples: floatSamples(from: frame.payload),
            receivedAtMs: nowMs())
          Task {
            let dropped = await queue.enqueue(request)
            for id in dropped {
              output.emit(["type": "dropped", "requestId": id, "reason": "superseded"])
            }
          }
        case "cancel":
          let ids = frame.header["requestIds"] as? [String] ?? []
          let sessionId = frame.header["sessionId"] as? String
          let previewsOnly = frame.header["previewsOnly"] as? Bool ?? false
          Task {
            var dropped = await queue.cancel(requestIds: ids)
            if previewsOnly { dropped += await queue.cancelPreviews(sessionId: sessionId) }
            for id in dropped {
              output.emit(["type": "dropped", "requestId": id, "reason": "cancelled"])
            }
          }
        case "ping":
          output.emit(["type": "pong", "at": nowMs(), "pending": 0])
        case "shutdown":
          Task { await queue.close() }
        default:
          emitLog("warn", "Unknown frame type: \(type)")
        }
      }
    }
  }
  reader.name = "openwhispr.asr-helper.stdin"
  reader.start()

  // Worker loop: strictly sequential inference (Core ML is the bottleneck; parallel requests only add jitter).
  while let request = await queue.next() {
    let dequeuedAt = nowMs()
    let samples = resampleToTarget(request.samples, from: request.sampleRate)
    do {
      let result = try await engine.transcribe(samples: samples, language: languageHint(request.language))
      let doneAt = nowMs()
      output.emit([
        "type": "result",
        "requestId": request.requestId,
        "sessionId": request.sessionId,
        "generation": request.generation,
        "source": request.source,
        "segmentId": request.segmentId,
        "kind": request.kind,
        "text": result.text,
        "confidence": Double(result.confidence),
        "startMs": request.startMs,
        "endMs": request.endMs,
        "audioMs": Double(samples.count) / Double(targetSampleRate) * 1000,
        "queueMs": dequeuedAt - request.receivedAtMs,
        "processingMs": doneAt - dequeuedAt,
        "engine": engineName,
      ])
    } catch {
      output.emit([
        "type": "error",
        "requestId": request.requestId,
        "sessionId": request.sessionId,
        "generation": request.generation,
        "source": request.source,
        "segmentId": request.segmentId,
        "kind": request.kind,
        "message": error.localizedDescription,
      ])
    }
  }
  output.emit(["type": "closed"])
  exit(0)
}

// MARK: - Entry

let options = parseCli()
let modelDir = options.modelDir ?? defaultModelDir()

switch options.mode {
case "check":
  runCheck(modelDir: modelDir)
case "download":
  Task { await runDownload(modelDir: modelDir) }
  dispatchMain()
case "file":
  guard let filePath = options.filePath else {
    output.emit(["type": "fatal", "message": "--transcribe-file requires a path"])
    exit(1)
  }
  Task { await runFile(path: filePath, modelDir: modelDir, language: options.language) }
  dispatchMain()
default:
  Task { await runServe(modelDir: modelDir) }
  dispatchMain()
}
