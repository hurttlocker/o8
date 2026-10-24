// Read-only RSS attribution for one explicitly owned browser process.
import Foundation
@_silgen_name("responsibility_get_pid_responsible_for_pid")
func responsiblePID(_ pid: pid_t) -> pid_t
let root = pid_t(CommandLine.arguments[1])!
let command = Process()
command.executableURL = URL(fileURLWithPath: "/bin/ps")
command.arguments = ["-axo", "pid=,ppid=,rss=,comm="]
let pipe = Pipe(); command.standardOutput = pipe
try command.run()
let data = pipe.fileHandleForReading.readDataToEndOfFile(); command.waitUntilExit()
let rows = String(data: data, encoding: .utf8)!.split(separator: "\n").compactMap { line -> (pid_t, pid_t, Double, String)? in
  let parts = line.split(maxSplits: 3, whereSeparator: { $0 == " " || $0 == "\t" })
  guard parts.count == 4, let pid = pid_t(parts[0]), let parent = pid_t(parts[1]), let rss = Double(parts[2]) else { return nil }
  return (pid, parent, rss / 1024, String(parts[3]))
}
var owned: Set<pid_t> = [root]
for _ in 0..<10 {
  for row in rows where owned.contains(row.1) { owned.insert(row.0) }
}
let before = Set((ProcessInfo.processInfo.environment["BENCH_BEFORE_PIDS"] ?? "").split(separator: ",").compactMap { pid_t($0) })
let browserRows = rows.filter { owned.contains($0.0) && $0.3.hasSuffix("/Playwright") }
let responsibility = Set(browserRows.map { responsiblePID($0.0) })
let bundles = browserRows.compactMap { $0.3.components(separatedBy: "/Playwright.app/").first }
let attributed = rows.filter { row in
  owned.contains(row.0) || (!before.contains(row.0) && bundles.contains(where: { row.3.hasPrefix($0 + "/") }) && responsibility.contains(responsiblePID(row.0)))
}
let processes: [[String: Any]] = attributed.map { row in
  let role = (row.3.contains("WebContent") || row.3.contains("WebProcess")) ? "web-content" : row.3.contains("GPU") ? "gpu" : row.3.contains("Networking") ? "network" : "browser"
  return ["role": role, "rssMiB": row.2, "binary": URL(fileURLWithPath: row.3).lastPathComponent]
}
if CommandLine.arguments.contains("--diagnostic") {
  let candidates = rows.filter { $0.3.contains("WebKit") || $0.3.contains("Playwright") }.map { row in
    ["pid": Int(row.0), "parent": Int(row.1), "responsible": Int(responsiblePID(row.0)), "binary": row.3] as [String: Any]
  }
  FileHandle.standardError.write(try JSONSerialization.data(withJSONObject: candidates))
}
let result: [String: Any] = ["rssMiB": attributed.reduce(0) { $0 + $1.2 }, "processes": processes,
  "method": "owned browser tree plus fresh same-bundle XPC processes with matching responsibility"]
FileHandle.standardOutput.write(try JSONSerialization.data(withJSONObject: result, options: [.sortedKeys]))
