#!/usr/bin/env swift
/**
 * Stamp Apple Live Photo pairing metadata onto a still + companion MOV.
 *
 * Usage: stamp-live-photo.swift <stillPath> <movPath> [contentIdentifier]
 *
 * Writes matching `com.apple.quicktime.content.identifier` on the MOV (plus a
 * still-image-time timed metadata track) and MakerApple asset identifier "17"
 * on the still so Messages can assemble a .pvt / iris pair.
 */
import AVFoundation
import CoreMedia
import Foundation
import ImageIO
import UniformTypeIdentifiers

guard CommandLine.arguments.count >= 3 else {
    fputs("usage: stamp-live-photo.swift <still> <mov> [uuid]\n", stderr)
    exit(2)
}

let stillPath = CommandLine.arguments[1]
let movPath = CommandLine.arguments[2]
let contentId = (CommandLine.arguments.count >= 4 ? CommandLine.arguments[3] : UUID().uuidString).uppercased()

enum StampError: Error {
    case imageSource
    case imageDestination
    case reader(Error?)
    case writer(Error?)
    case noVideoTrack
    case metadataFormat
    case cannotAddInput
    case appendFailed
}

func stampStill(path: String, id: String) throws {
    let url = URL(fileURLWithPath: path)
    guard let source = CGImageSourceCreateWithURL(url as CFURL, nil) else { throw StampError.imageSource }
    let uti = (CGImageSourceGetType(source) as String?) ?? UTType.jpeg.identifier
    let tmp = url.deletingLastPathComponent().appendingPathComponent(".stamp-\(UUID().uuidString).\(url.pathExtension)")
    guard let dest = CGImageDestinationCreateWithURL(tmp as CFURL, uti as CFString, 1, nil) else {
        throw StampError.imageDestination
    }

    var props = (CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any]) ?? [:]
    var makerApple = (props[kCGImagePropertyMakerAppleDictionary] as? [String: Any]) ?? [:]
    makerApple["17"] = id
    props[kCGImagePropertyMakerAppleDictionary] = makerApple

    CGImageDestinationAddImageFromSource(dest, source, 0, props as CFDictionary)
    guard CGImageDestinationFinalize(dest) else { throw StampError.imageDestination }
    try FileManager.default.removeItem(at: url)
    try FileManager.default.moveItem(at: tmp, to: url)
}

func quickTimeItem(key: String, value: Any, dataType: String? = nil) -> AVMetadataItem {
    let item = AVMutableMetadataItem()
    item.key = key as NSString
    item.keySpace = .quickTimeMetadata
    item.value = value as? NSCopying & NSObjectProtocol
    item.dataType = dataType
    return item
}

func stampMov(path: String, id: String) throws {
    let inputUrl = URL(fileURLWithPath: path)
    let asset = AVURLAsset(url: inputUrl)
    guard let videoTrack = asset.tracks(withMediaType: .video).first else { throw StampError.noVideoTrack }

    let tmp = inputUrl.deletingLastPathComponent().appendingPathComponent(".stamp-\(UUID().uuidString).mov")
    try? FileManager.default.removeItem(at: tmp)

    let reader = try AVAssetReader(asset: asset)
    let readerOutput = AVAssetReaderTrackOutput(track: videoTrack, outputSettings: nil)
    readerOutput.alwaysCopiesSampleData = false
    guard reader.canAdd(readerOutput) else { throw StampError.cannotAddInput }
    reader.add(readerOutput)

    var audioOutput: AVAssetReaderTrackOutput?
    var audioWriterInput: AVAssetWriterInput?
    if let audioTrack = asset.tracks(withMediaType: .audio).first {
        let out = AVAssetReaderTrackOutput(track: audioTrack, outputSettings: nil)
        out.alwaysCopiesSampleData = false
        if reader.canAdd(out) {
            reader.add(out)
            audioOutput = out
        }
    }

    let writer = try AVAssetWriter(outputURL: tmp, fileType: .mov)
    writer.metadata = [quickTimeItem(key: "com.apple.quicktime.content.identifier", value: id)]

    let videoInput = AVAssetWriterInput(mediaType: .video, outputSettings: nil)
    videoInput.expectsMediaDataInRealTime = false
    videoInput.transform = videoTrack.preferredTransform
    guard writer.canAdd(videoInput) else { throw StampError.cannotAddInput }
    writer.add(videoInput)

    if audioOutput != nil {
        let aIn = AVAssetWriterInput(mediaType: .audio, outputSettings: nil)
        aIn.expectsMediaDataInRealTime = false
        if writer.canAdd(aIn) {
            writer.add(aIn)
            audioWriterInput = aIn
        }
    }

    let stillSpec: [CFString: Any] = [
        kCMMetadataFormatDescriptionMetadataSpecificationKey_Identifier as CFString:
            "mdta/com.apple.quicktime.still-image-time",
        kCMMetadataFormatDescriptionMetadataSpecificationKey_DataType as CFString:
            kCMMetadataBaseDataType_SInt8
    ]
    var formatDesc: CMFormatDescription?
    let status = CMMetadataFormatDescriptionCreateWithMetadataSpecifications(
        allocator: kCFAllocatorDefault,
        metadataType: kCMMetadataFormatType_Boxed,
        metadataSpecifications: [stillSpec] as CFArray,
        formatDescriptionOut: &formatDesc
    )
    guard status == noErr, let formatDesc else { throw StampError.metadataFormat }

    let metaInput = AVAssetWriterInput(mediaType: .metadata, outputSettings: nil, sourceFormatHint: formatDesc)
    let adaptor = AVAssetWriterInputMetadataAdaptor(assetWriterInput: metaInput)
    guard writer.canAdd(metaInput) else { throw StampError.cannotAddInput }
    writer.add(metaInput)

    guard writer.startWriting() else { throw StampError.writer(writer.error) }
    guard reader.startReading() else { throw StampError.reader(reader.error) }
    writer.startSession(atSourceTime: .zero)

    let stillItem = quickTimeItem(
        key: "com.apple.quicktime.still-image-time",
        value: NSNumber(value: Int8(-1)),
        dataType: kCMMetadataBaseDataType_SInt8 as String
    )
    let group = AVTimedMetadataGroup(
        items: [stillItem],
        timeRange: CMTimeRange(start: .zero, duration: CMTime(value: 1, timescale: 600))
    )
    guard adaptor.append(group) else { throw StampError.appendFailed }
    metaInput.markAsFinished()

    let sem = DispatchSemaphore(value: 0)
    var failed = false

    func pump(output: AVAssetReaderTrackOutput?, input: AVAssetWriterInput?, label: String) {
        guard let output, let input else { return }
        let q = DispatchQueue(label: "stamp.\(label)")
        input.requestMediaDataWhenReady(on: q) {
            while input.isReadyForMoreMediaData {
                if let sample = output.copyNextSampleBuffer() {
                    if !input.append(sample) {
                        failed = true
                        input.markAsFinished()
                        sem.signal()
                        return
                    }
                } else {
                    input.markAsFinished()
                    sem.signal()
                    return
                }
            }
        }
    }

    pump(output: readerOutput, input: videoInput, label: "video")
    if let audioOutput, let audioWriterInput {
        pump(output: audioOutput, input: audioWriterInput, label: "audio")
        sem.wait()
    }
    sem.wait()

    if failed {
        writer.cancelWriting()
        throw StampError.appendFailed
    }

    let finishSem = DispatchSemaphore(value: 0)
    writer.finishWriting { finishSem.signal() }
    finishSem.wait()
    guard writer.status == .completed else { throw StampError.writer(writer.error) }

    try FileManager.default.removeItem(at: inputUrl)
    try FileManager.default.moveItem(at: tmp, to: inputUrl)
}

do {
    try stampStill(path: stillPath, id: contentId)
    try stampMov(path: movPath, id: contentId)
    print("stamped contentId=\(contentId) still=\(stillPath) mov=\(movPath)")
} catch {
    fputs("stamp-live-photo failed: \(error)\n", stderr)
    exit(1)
}
