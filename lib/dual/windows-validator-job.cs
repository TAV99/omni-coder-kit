using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;

// Job Object ownership and accounting follow the documented Win32 lifecycle:
// https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects
// The validator is created suspended, assigned, then resumed. Its inherited
// handles are restricted with PROC_THREAD_ATTRIBUTE_HANDLE_LIST:
// https://learn.microsoft.com/en-us/windows/win32/procthread/inheritance
public static class DualValidatorJob
{
    private const uint CREATE_SUSPENDED = 0x00000004;
    private const uint CREATE_NO_WINDOW = 0x08000000;
    private const uint EXTENDED_STARTUPINFO_PRESENT = 0x00080000;
    private const uint CREATE_UNICODE_ENVIRONMENT = 0x00000400;
    private const uint STARTF_USESTDHANDLES = 0x00000100;
    private const uint PROC_THREAD_ATTRIBUTE_HANDLE_LIST = 0x00020002;
    private const uint JOB_OBJECT_EXTENDED_LIMIT_INFORMATION = 9;
    private const uint JOB_OBJECT_BASIC_ACCOUNTING_INFORMATION = 1;
    private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
    private const uint HANDLE_FLAG_INHERIT = 0x00000001;
    private const uint GENERIC_READ = 0x80000000;
    private const uint FILE_SHARE_READ = 0x00000001;
    private const uint FILE_SHARE_WRITE = 0x00000002;
    private const uint OPEN_EXISTING = 3;
    private const uint FILE_ATTRIBUTE_NORMAL = 0x00000080;
    private const uint WAIT_OBJECT_0 = 0;
    private const uint WAIT_TIMEOUT = 258;
    private const uint INFINITE = 0xffffffff;
    private const uint STILL_ACTIVE = 259;
    private const int READ_CHUNK_BYTES = 8192;
    private const int MAX_CONTROL_FRAME_BYTES = 1024 * 1024;

    [StructLayout(LayoutKind.Sequential)]
    private struct SECURITY_ATTRIBUTES
    {
        public int nLength;
        public IntPtr lpSecurityDescriptor;
        [MarshalAs(UnmanagedType.Bool)] public bool bInheritHandle;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct STARTUPINFO
    {
        public int cb;
        public string lpReserved;
        public string lpDesktop;
        public string lpTitle;
        public uint dwX;
        public uint dwY;
        public uint dwXSize;
        public uint dwYSize;
        public uint dwXCountChars;
        public uint dwYCountChars;
        public uint dwFillAttribute;
        public uint dwFlags;
        public short wShowWindow;
        public short cbReserved2;
        public IntPtr lpReserved2;
        public IntPtr hStdInput;
        public IntPtr hStdOutput;
        public IntPtr hStdError;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct STARTUPINFOEX
    {
        public STARTUPINFO StartupInfo;
        public IntPtr lpAttributeList;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct PROCESS_INFORMATION
    {
        public IntPtr hProcess;
        public IntPtr hThread;
        public uint dwProcessId;
        public uint dwThreadId;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IO_COUNTERS
    {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_BASIC_LIMIT_INFORMATION
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_BASIC_ACCOUNTING_INFORMATION
    {
        public long TotalUserTime;
        public long TotalKernelTime;
        public long ThisPeriodTotalUserTime;
        public long ThisPeriodTotalKernelTime;
        public uint TotalPageFaultCount;
        public uint TotalProcesses;
        public uint ActiveProcesses;
        public uint TotalTerminatedProcesses;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateJobObjectW(IntPtr securityAttributes, string name);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetInformationJobObject(IntPtr job, uint informationClass, ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION information, uint informationLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool QueryInformationJobObject(IntPtr job, uint informationClass, out JOBOBJECT_BASIC_ACCOUNTING_INFORMATION information, uint informationLength, out uint returnLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool TerminateJobObject(IntPtr job, uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CreatePipe(out IntPtr readPipe, out IntPtr writePipe, ref SECURITY_ATTRIBUTES attributes, uint size);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateFileW(string fileName, uint desiredAccess, uint shareMode, ref SECURITY_ATTRIBUTES securityAttributes, uint creationDisposition, uint flagsAndAttributes, IntPtr templateFile);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool InitializeProcThreadAttributeList(IntPtr attributeList, int attributeCount, int flags, ref IntPtr size);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool UpdateProcThreadAttribute(IntPtr attributeList, uint flags, IntPtr attribute, IntPtr value, IntPtr size, IntPtr previousValue, IntPtr returnSize);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern void DeleteProcThreadAttributeList(IntPtr attributeList);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CreateProcessW(string applicationName, StringBuilder commandLine, IntPtr processAttributes, IntPtr threadAttributes, bool inheritHandles, uint creationFlags, IntPtr environment, string currentDirectory, ref STARTUPINFOEX startupInfo, out PROCESS_INFORMATION processInformation);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint ResumeThread(IntPtr thread);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool TerminateProcess(IntPtr process, uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CloseHandle(IntPtr handle);

    private static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = 16 * 1024 * 1024 };
    private static readonly object WriteLock = new object();
    private static readonly object OutputLock = new object();
    private static Stream ControlInput;
    private static Stream ControlOutput;
    private static byte[] Secret;
    private static int OutSequence;
    private static int InSequence = 1;
    private static long ForwardedOutputBytes;
    private static long MaximumOutputBytes;
    private static int OutputLimitReached;
    private static int CancelRequested;
    private static string CancelReason;
    private static int CleanupTimeoutMs;
    private static int InputProtocolFailure;

    public static void Run()
    {
        ControlInput = Console.OpenStandardInput();
        ControlOutput = Console.OpenStandardOutput();
        Dictionary<string, object> envelope;
        Dictionary<string, object> request;
        string payload;
        try
        {
            byte[] frame = ReadFrame(ControlInput);
            if (frame == null) return;
            envelope = DeserializeDictionary(Encoding.UTF8.GetString(frame));
            Secret = Convert.FromBase64String(ReadString(envelope, "secret"));
            payload = ReadString(envelope, "payload");
            if (Secret.Length != 32 || ReadInt(envelope, "sequence") != 0 || !VerifyMac(Secret, 0, payload, ReadString(envelope, "mac"))) return;
            request = DeserializeDictionary(payload);
            if (ReadString(request, "type") != "start") return;
            MaximumOutputBytes = Math.Max(1, Math.Min(16L * 1024L * 1024L, ReadLong(request, "maxOutputBytes")));
            CleanupTimeoutMs = (int)Math.Max(1, Math.Min(30000, ReadLong(request, "cleanupTimeoutMs")));
        }
        catch
        {
            return;
        }

        WriteFrame(new Dictionary<string, object> { { "type", "helper-ready" } });
        Thread inputThread = new Thread(ReadCommands);
        inputThread.IsBackground = true;
        inputThread.Start();
        RunValidator(request);
    }

    private static void RunValidator(Dictionary<string, object> request)
    {
        IntPtr job = IntPtr.Zero;
        IntPtr stdinHandle = IntPtr.Zero;
        IntPtr stdoutRead = IntPtr.Zero;
        IntPtr stdoutWrite = IntPtr.Zero;
        IntPtr stderrRead = IntPtr.Zero;
        IntPtr stderrWrite = IntPtr.Zero;
        IntPtr attributeList = IntPtr.Zero;
        IntPtr handleList = IntPtr.Zero;
        IntPtr environment = IntPtr.Zero;
        PROCESS_INFORMATION process = new PROCESS_INFORMATION();
        bool processCreated = false;
        bool assigned = false;
        bool cleanupVerified = false;
        bool launched = false;
        string stage = "validator-preflight";
        Task stdoutTask = null;
        Task stderrTask = null;

        try
        {
            string executable = ReadString(request, "program");
            string cwd = ReadString(request, "cwd");
            string[] args = ReadStringArray(request, "args");
            Dictionary<string, object> env = ReadDictionary(request, "env");
            if (String.IsNullOrEmpty(executable) || !Path.IsPathRooted(executable) || String.IsNullOrEmpty(cwd) || !Path.IsPathRooted(cwd))
            {
                WriteLaunchFailed("DUAL_VALIDATOR_SPEC_INVALID");
                return;
            }

            stage = "job-create";
            job = CreateJobObjectW(IntPtr.Zero, null);
            if (job == IntPtr.Zero) throw new Win32Exception("JOB_CREATE_FAILED");
            stage = "job-configure";
            JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if (!SetInformationJobObject(job, JOB_OBJECT_EXTENDED_LIMIT_INFORMATION, ref limits, (uint)Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION))))
                throw new Win32Exception("JOB_CONFIGURE_FAILED");

            stage = "validator-pipes";
            SECURITY_ATTRIBUTES pipeSecurity = NewInheritableSecurityAttributes();
            if (!CreatePipe(out stdoutRead, out stdoutWrite, ref pipeSecurity, 0)
                || !SetHandleInformation(stdoutRead, HANDLE_FLAG_INHERIT, 0)) throw new Win32Exception("STDOUT_PIPE_FAILED");
            if (!CreatePipe(out stderrRead, out stderrWrite, ref pipeSecurity, 0)
                || !SetHandleInformation(stderrRead, HANDLE_FLAG_INHERIT, 0)) throw new Win32Exception("STDERR_PIPE_FAILED");
            stdinHandle = CreateFileW("NUL", GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE, ref pipeSecurity, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, IntPtr.Zero);
            if (stdinHandle == IntPtr.Zero || stdinHandle == new IntPtr(-1)) throw new Win32Exception("STDIN_HANDLE_FAILED");

            stage = "handle-allowlist";
            IntPtr attributeBytes = IntPtr.Zero;
            InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref attributeBytes);
            attributeList = Marshal.AllocHGlobal(attributeBytes);
            if (!InitializeProcThreadAttributeList(attributeList, 1, 0, ref attributeBytes)) throw new Win32Exception("HANDLE_LIST_INIT_FAILED");
            handleList = Marshal.AllocHGlobal(IntPtr.Size * 3);
            Marshal.WriteIntPtr(handleList, 0, stdinHandle);
            Marshal.WriteIntPtr(handleList, IntPtr.Size, stdoutWrite);
            Marshal.WriteIntPtr(handleList, IntPtr.Size * 2, stderrWrite);
            if (!UpdateProcThreadAttribute(attributeList, 0, new IntPtr(PROC_THREAD_ATTRIBUTE_HANDLE_LIST), handleList, new IntPtr(IntPtr.Size * 3), IntPtr.Zero, IntPtr.Zero))
                throw new Win32Exception("HANDLE_LIST_SET_FAILED");

            STARTUPINFOEX startup = new STARTUPINFOEX();
            startup.StartupInfo.cb = Marshal.SizeOf(typeof(STARTUPINFOEX));
            startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
            startup.StartupInfo.hStdInput = stdinHandle;
            startup.StartupInfo.hStdOutput = stdoutWrite;
            startup.StartupInfo.hStdError = stderrWrite;
            startup.lpAttributeList = attributeList;
            string commandLine = QuoteArgument(executable);
            for (int index = 0; index < args.Length; index++) commandLine += " " + QuoteArgument(args[index]);
            StringBuilder mutableCommandLine = new StringBuilder(commandLine);
            string envBlock = BuildEnvironmentBlock(env);
            environment = Marshal.StringToHGlobalUni(envBlock);
            stage = "create-process";
            uint flags = CREATE_SUSPENDED | CREATE_NO_WINDOW | EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT;
            if (!CreateProcessW(executable, mutableCommandLine, IntPtr.Zero, IntPtr.Zero, true, flags, environment, cwd, ref startup, out process))
            {
                cleanupVerified = VerifyEmptyJob(job, CleanupTimeoutMs);
                if (cleanupVerified) WriteLaunchFailed("DUAL_VALIDATOR_CREATE_PROCESS_FAILED");
                else WriteCleanupUnproven(stage);
                return;
            }
            processCreated = true;
            CloseHandle(stdoutWrite); stdoutWrite = IntPtr.Zero;
            CloseHandle(stderrWrite); stderrWrite = IntPtr.Zero;
            CloseHandle(stdinHandle); stdinHandle = IntPtr.Zero;

            stage = "job-assignment";
            bool injectedAssignmentFailure = ReadBoolean(request, "simulateAssignmentFailure");
            if (injectedAssignmentFailure || !AssignProcessToJobObject(job, process.hProcess))
            {
                TerminateProcess(process.hProcess, 0xE0000011);
                bool processExited = WaitForSingleObject(process.hProcess, (uint)CleanupTimeoutMs) == WAIT_OBJECT_0;
                cleanupVerified = processExited && VerifyEmptyJob(job, CleanupTimeoutMs);
                if (cleanupVerified) WriteLaunchFailed("DUAL_VALIDATOR_JOB_ASSIGNMENT_FAILED");
                else WriteCleanupUnproven(stage);
                return;
            }
            assigned = true;
            stage = "resume-thread";
            uint resumeCount = ResumeThread(process.hThread);
            if (resumeCount == 0xffffffff)
            {
                TerminateJobObject(job, 0xE0000012);
                cleanupVerified = WaitForSingleObject(process.hProcess, (uint)CleanupTimeoutMs) == WAIT_OBJECT_0
                    && VerifyEmptyJob(job, CleanupTimeoutMs);
                if (cleanupVerified) WriteLaunchFailed("DUAL_VALIDATOR_RESUME_FAILED");
                else WriteCleanupUnproven(stage);
                return;
            }

            launched = true;
            WriteFrame(new Dictionary<string, object> { { "type", "started" } });
            stdoutTask = DrainPipe(stdoutRead, "stdout", job);
            stderrTask = DrainPipe(stderrRead, "stderr", job);
            stdoutRead = IntPtr.Zero;
            stderrRead = IntPtr.Zero;

            stage = "owned-process-wait";
            bool directExited = false;
            bool ownerStop = false;
            while (true)
            {
                if (Volatile.Read(ref CancelRequested) != 0 || Volatile.Read(ref OutputLimitReached) != 0 || Volatile.Read(ref InputProtocolFailure) != 0)
                {
                    ownerStop = true;
                    break;
                }
                directExited = WaitForSingleObject(process.hProcess, 50) == WAIT_OBJECT_0;
                uint active = GetActiveProcessCount(job);
                if (directExited && active == 0) break;
            }

            if (ownerStop)
            {
                TerminateJobObject(job, 0xE0000013);
                cleanupVerified = WaitForSingleObject(process.hProcess, (uint)CleanupTimeoutMs) == WAIT_OBJECT_0
                    && VerifyEmptyJob(job, CleanupTimeoutMs);
            }
            else
            {
                cleanupVerified = GetActiveProcessCount(job) == 0;
            }

            if (!cleanupVerified)
            {
                TerminateJobObject(job, 0xE0000014);
                WriteCleanupUnproven(stage);
                return;
            }

            stage = "output-drain";
            bool outputTasksCompleted;
            try
            {
                outputTasksCompleted = Task.WaitAll(new[] { stdoutTask, stderrTask }, CleanupTimeoutMs);
            }
            catch (AggregateException error)
            {
                TerminateJobObject(job, 0xE0000019);
                AggregateException flattened = error.Flatten();
                Exception root = flattened.InnerExceptions.Count == 0 ? null : flattened.InnerExceptions[0];
                string errorType = root == null ? "unknown" : root.GetType().Name.ToLowerInvariant();
                string errorCode = "output-drain-" + SafeStage(errorType);
                ArgumentException argumentError = root as ArgumentException;
                if (argumentError != null) errorCode += "-" + SafeStage(argumentError.ParamName ?? "no-param");
                if (root != null) errorCode += "-hr-" + unchecked((uint)root.HResult).ToString("x8");
                WriteCleanupUnproven(errorCode);
                return;
            }
            if (!outputTasksCompleted)
            {
                TerminateJobObject(job, 0xE0000015);
                WriteCleanupUnproven("output-drain-timeout");
                return;
            }

            stage = "exit-code";
            uint exitCode;
            if (!GetExitCodeProcess(process.hProcess, out exitCode) || exitCode == STILL_ACTIVE)
            {
                WriteCleanupUnproven(stage);
                return;
            }
            stage = "final-job-accounting";
            cleanupVerified = VerifyEmptyJob(job, CleanupTimeoutMs);
            if (!cleanupVerified)
            {
                WriteCleanupUnproven(stage);
                return;
            }

            WriteFrame(new Dictionary<string, object> {
                { "type", "settled" },
                { "exitCode", unchecked((int)exitCode) },
                { "signal", null },
                { "cleanupVerified", true },
                { "activeOwnedProcesses", 0 },
                { "streamsComplete", Volatile.Read(ref CancelRequested) == 0 && Volatile.Read(ref OutputLimitReached) == 0 }
            });
        }
        catch
        {
            if (job != IntPtr.Zero && processCreated && assigned) TerminateJobObject(job, 0xE0000016);
            if (processCreated && !assigned) TerminateProcess(process.hProcess, 0xE0000017);
            if (job != IntPtr.Zero && processCreated)
            {
                bool directExited = WaitForSingleObject(process.hProcess, (uint)CleanupTimeoutMs) == WAIT_OBJECT_0;
                cleanupVerified = directExited && VerifyEmptyJob(job, CleanupTimeoutMs);
            }
            if (cleanupVerified && !launched) WriteLaunchFailed("DUAL_VALIDATOR_LAUNCH_FAILED");
            else WriteCleanupUnproven(stage);
        }
        finally
        {
            if (process.hThread != IntPtr.Zero) CloseHandle(process.hThread);
            if (process.hProcess != IntPtr.Zero) CloseHandle(process.hProcess);
            if (attributeList != IntPtr.Zero)
            {
                DeleteProcThreadAttributeList(attributeList);
                Marshal.FreeHGlobal(attributeList);
            }
            if (handleList != IntPtr.Zero) Marshal.FreeHGlobal(handleList);
            if (environment != IntPtr.Zero) Marshal.FreeHGlobal(environment);
            CloseIfOpen(stdinHandle);
            CloseIfOpen(stdoutRead);
            CloseIfOpen(stdoutWrite);
            CloseIfOpen(stderrRead);
            CloseIfOpen(stderrWrite);
            // KILL_ON_JOB_CLOSE is the final best-effort cleanup if proof failed.
            CloseIfOpen(job);
        }
    }

    private static SECURITY_ATTRIBUTES NewInheritableSecurityAttributes()
    {
        SECURITY_ATTRIBUTES attributes = new SECURITY_ATTRIBUTES();
        attributes.nLength = Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES));
        attributes.bInheritHandle = true;
        return attributes;
    }

    private static Task DrainPipe(IntPtr readHandle, string stream, IntPtr job)
    {
        return Task.Run(() =>
        {
            // CreatePipe anonymous handles are synchronous; reads run on dedicated thread-pool tasks.
            using (FileStream input = new FileStream(new Microsoft.Win32.SafeHandles.SafeFileHandle(readHandle, true), FileAccess.Read, READ_CHUNK_BYTES, false))
            {
                byte[] buffer = new byte[READ_CHUNK_BYTES];
                while (true)
                {
                    int read = input.Read(buffer, 0, buffer.Length);
                    if (read <= 0) break;
                    int allowed;
                    bool exceeded;
                    lock (OutputLock)
                    {
                        long remaining = Math.Max(0, MaximumOutputBytes - ForwardedOutputBytes);
                        allowed = (int)Math.Min(read, remaining);
                        exceeded = allowed < read;
                        if (allowed > 0)
                        {
                            byte[] bytes = new byte[allowed];
                            Buffer.BlockCopy(buffer, 0, bytes, 0, allowed);
                            ForwardedOutputBytes += allowed;
                            WriteFrame(new Dictionary<string, object> {
                                { "type", "output" },
                                { "stream", stream },
                                { "data", Convert.ToBase64String(bytes) }
                            });
                        }
                        if (exceeded && Interlocked.Exchange(ref OutputLimitReached, 1) == 0)
                        {
                            WriteFrame(new Dictionary<string, object> { { "type", "output-limit" } });
                        }
                    }
                    if (exceeded) TerminateJobObject(job, 0xE0000018);
                }
            }
        });
    }

    private static bool VerifyEmptyJob(IntPtr job, int timeoutMs)
    {
        if (job == IntPtr.Zero || job == new IntPtr(-1)) return false;
        DateTime deadline = DateTime.UtcNow.AddMilliseconds(timeoutMs);
        while (DateTime.UtcNow <= deadline)
        {
            uint active = GetActiveProcessCount(job);
            if (active == 0) return true;
            Thread.Sleep(20);
        }
        return false;
    }

    private static uint GetActiveProcessCount(IntPtr job)
    {
        JOBOBJECT_BASIC_ACCOUNTING_INFORMATION info;
        uint returned;
        if (!QueryInformationJobObject(job, JOB_OBJECT_BASIC_ACCOUNTING_INFORMATION, out info, (uint)Marshal.SizeOf(typeof(JOBOBJECT_BASIC_ACCOUNTING_INFORMATION)), out returned))
            throw new Win32Exception("JOB_ACCOUNTING_QUERY_FAILED");
        return info.ActiveProcesses;
    }

    private static string BuildEnvironmentBlock(Dictionary<string, object> values)
    {
        SortedDictionary<string, string> normalized = new SortedDictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (KeyValuePair<string, object> pair in values)
        {
            string value = pair.Value as string;
            if (String.IsNullOrEmpty(pair.Key) || pair.Key.Contains("=") || pair.Key.IndexOf('\0') >= 0 || value == null || value.IndexOf('\0') >= 0)
                throw new InvalidDataException("invalid environment entry");
            if (!normalized.ContainsKey(pair.Key)) normalized[pair.Key] = value;
        }
        StringBuilder block = new StringBuilder();
        foreach (KeyValuePair<string, string> pair in normalized) block.Append(pair.Key).Append('=').Append(pair.Value).Append('\0');
        block.Append('\0');
        return block.ToString();
    }

    private static string QuoteArgument(string argument)
    {
        if (argument.Length > 0 && argument.IndexOfAny(new[] { ' ', '\t', '\n', '\v', '"' }) < 0) return argument;
        StringBuilder quoted = new StringBuilder();
        quoted.Append('"');
        int slashes = 0;
        foreach (char character in argument)
        {
            if (character == '\\') { slashes++; continue; }
            if (character == '"')
            {
                quoted.Append('\\', slashes * 2 + 1).Append('"');
                slashes = 0;
                continue;
            }
            if (slashes > 0) { quoted.Append('\\', slashes); slashes = 0; }
            quoted.Append(character);
        }
        if (slashes > 0) quoted.Append('\\', slashes * 2);
        quoted.Append('"');
        return quoted.ToString();
    }

    private static void ReadCommands()
    {
        while (true)
        {
            try
            {
                byte[] frame = ReadFrame(ControlInput);
                if (frame == null)
                {
                    CancelReason = "helper-input-closed";
                    Interlocked.Exchange(ref CancelRequested, 1);
                    return;
                }
                Dictionary<string, object> envelope = DeserializeDictionary(Encoding.UTF8.GetString(frame));
                string payload = ReadString(envelope, "payload");
                int sequence = ReadInt(envelope, "sequence");
                if (sequence != InSequence || !VerifyMac(Secret, sequence, payload, ReadString(envelope, "mac")))
                {
                    Interlocked.Exchange(ref InputProtocolFailure, 1);
                    CancelReason = "protocol-invalid";
                    Interlocked.Exchange(ref CancelRequested, 1);
                    return;
                }
                InSequence++;
                Dictionary<string, object> body = DeserializeDictionary(payload);
                if (ReadString(body, "type") == "cancel")
                {
                    CancelReason = ReadString(body, "reason");
                    Interlocked.Exchange(ref CancelRequested, 1);
                    return;
                }
                Interlocked.Exchange(ref InputProtocolFailure, 1);
                CancelReason = "protocol-invalid";
                Interlocked.Exchange(ref CancelRequested, 1);
                return;
            }
            catch
            {
                Interlocked.Exchange(ref InputProtocolFailure, 1);
                CancelReason = "protocol-invalid";
                Interlocked.Exchange(ref CancelRequested, 1);
                return;
            }
        }
    }

    private static byte[] ReadFrame(Stream stream)
    {
        byte[] header = ReadExact(stream, 4);
        if (header == null) return null;
        int length = (header[0] << 24) | (header[1] << 16) | (header[2] << 8) | header[3];
        if (length < 1 || length > MAX_CONTROL_FRAME_BYTES) throw new InvalidDataException("invalid frame length");
        return ReadExact(stream, length);
    }

    private static byte[] ReadExact(Stream stream, int length)
    {
        byte[] bytes = new byte[length];
        int offset = 0;
        while (offset < length)
        {
            int read = stream.Read(bytes, offset, length - offset);
            if (read <= 0)
            {
                if (offset == 0) return null;
                throw new EndOfStreamException();
            }
            offset += read;
        }
        return bytes;
    }

    private static void WriteFrame(Dictionary<string, object> body)
    {
        string payload = Json.Serialize(body);
        int sequence;
        lock (WriteLock)
        {
            sequence = OutSequence++;
            Dictionary<string, object> envelope = new Dictionary<string, object> {
                { "sequence", sequence },
                { "payload", payload },
                { "mac", ComputeMac(Secret, sequence, payload) }
            };
            byte[] json = Encoding.UTF8.GetBytes(Json.Serialize(envelope));
            byte[] frame = new byte[json.Length + 4];
            frame[0] = (byte)((json.Length >> 24) & 0xff);
            frame[1] = (byte)((json.Length >> 16) & 0xff);
            frame[2] = (byte)((json.Length >> 8) & 0xff);
            frame[3] = (byte)(json.Length & 0xff);
            Buffer.BlockCopy(json, 0, frame, 4, json.Length);
            ControlOutput.Write(frame, 0, frame.Length);
            ControlOutput.Flush();
        }
    }

    private static void WriteLaunchFailed(string code)
    {
        try
        {
            WriteFrame(new Dictionary<string, object> {
                { "type", "launch-failed" },
                { "code", code },
                { "cleanupVerified", true },
                { "activeOwnedProcesses", 0 }
            });
        }
        catch { }
    }

    private static void WriteCleanupUnproven(string stage = "unknown")
    {
        try { WriteFrame(new Dictionary<string, object> { { "type", "cleanup-unproven" }, { "code", stage } }); }
        catch { }
    }

    private static Dictionary<string, object> DeserializeDictionary(string json)
    {
        object value = Json.DeserializeObject(json);
        Dictionary<string, object> dictionary = value as Dictionary<string, object>;
        if (dictionary == null) throw new InvalidDataException("expected object");
        return dictionary;
    }

    private static Dictionary<string, object> ReadDictionary(Dictionary<string, object> source, string key)
    {
        object value;
        if (!source.TryGetValue(key, out value)) throw new InvalidDataException("missing object");
        Dictionary<string, object> dictionary = value as Dictionary<string, object>;
        if (dictionary == null) throw new InvalidDataException("invalid object");
        return dictionary;
    }

    private static string ReadString(Dictionary<string, object> source, string key)
    {
        object value;
        if (!source.TryGetValue(key, out value) || !(value is string)) throw new InvalidDataException("missing string");
        return (string)value;
    }

    private static string[] ReadStringArray(Dictionary<string, object> source, string key)
    {
        object value;
        if (!source.TryGetValue(key, out value)) throw new InvalidDataException("missing array");
        object[] array = value as object[];
        if (array == null) throw new InvalidDataException("invalid array");
        List<string> result = new List<string>();
        foreach (object item in array)
        {
            if (!(item is string)) throw new InvalidDataException("invalid argument");
            result.Add((string)item);
        }
        return result.ToArray();
    }

    private static bool ReadBoolean(Dictionary<string, object> source, string key)
    {
        object value;
        return source.TryGetValue(key, out value) && value is bool && (bool)value;
    }

    private static long ReadLong(Dictionary<string, object> source, string key)
    {
        object value;
        if (!source.TryGetValue(key, out value)) return 0;
        if (value is int) return (int)value;
        if (value is long) return (long)value;
        if (value is decimal) return (long)(decimal)value;
        return 0;
    }

    private static int ReadInt(Dictionary<string, object> source, string key)
    {
        long value = ReadLong(source, key);
        if (value < Int32.MinValue || value > Int32.MaxValue) throw new InvalidDataException("integer out of range");
        return (int)value;
    }

    private static bool VerifyMac(byte[] secret, int sequence, string payload, string provided)
    {
        byte[] expected;
        byte[] actual;
        try
        {
            expected = Hmac(secret, sequence, payload);
            actual = HexToBytes(provided);
        }
        catch { return false; }
        if (expected.Length != actual.Length) return false;
        int difference = 0;
        for (int index = 0; index < expected.Length; index++) difference |= expected[index] ^ actual[index];
        return difference == 0;
    }

    private static string ComputeMac(byte[] secret, int sequence, string payload)
    {
        byte[] bytes = Hmac(secret, sequence, payload);
        StringBuilder hex = new StringBuilder(bytes.Length * 2);
        foreach (byte value in bytes) hex.Append(value.ToString("x2"));
        return hex.ToString();
    }

    private static byte[] Hmac(byte[] secret, int sequence, string payload)
    {
        using (HMACSHA256 hmac = new HMACSHA256(secret))
            return hmac.ComputeHash(Encoding.UTF8.GetBytes(sequence.ToString() + "\n" + payload));
    }

    private static byte[] HexToBytes(string hex)
    {
        if (hex == null || hex.Length % 2 != 0) throw new FormatException();
        byte[] bytes = new byte[hex.Length / 2];
        for (int index = 0; index < bytes.Length; index++) bytes[index] = Convert.ToByte(hex.Substring(index * 2, 2), 16);
        return bytes;
    }

    private static void CloseIfOpen(IntPtr handle)
    {
        if (handle != IntPtr.Zero && handle != new IntPtr(-1)) CloseHandle(handle);
    }

    private static string SafeStage(string value)
    {
        StringBuilder safe = new StringBuilder();
        foreach (char character in value)
        {
            if ((character >= 'a' && character <= 'z') || (character >= '0' && character <= '9') || character == '-') safe.Append(character);
        }
        return safe.Length == 0 ? "unknown" : safe.ToString();
    }

    private sealed class Win32Exception : Exception
    {
        public Win32Exception(string code) : base(code + ":" + Marshal.GetLastWin32Error().ToString()) { }
    }
}
