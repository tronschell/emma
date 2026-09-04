#ifndef _WIN32_WINNT
#define _WIN32_WINNT 0x0A00
#endif

#include <windows.h>
#include <io.h>
#include <stdio.h>
#include <stdlib.h>
#include <stdint.h>
#include <string.h>
#include <wchar.h>

#define BUFFER_BYTES 65536
#define RESIZE_LINE_BYTES 64

typedef void *HPCON;
typedef HRESULT(WINAPI *create_pseudo_console_fn)(COORD, HANDLE, HANDLE, DWORD, HPCON *);
typedef void(WINAPI *close_pseudo_console_fn)(HPCON);
typedef HRESULT(WINAPI *resize_pseudo_console_fn)(HPCON, COORD);

#ifndef PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE
#define PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE 0x00020016
#endif

typedef struct {
  HANDLE input;
  HANDLE output;
  HANDLE stdout_handle;
  HANDLE resize;
  HANDLE pty_input;
  HPCON console;
  volatile LONG relay_failure;
} relay_context;

static create_pseudo_console_fn create_pseudo_console(void) {
  return (create_pseudo_console_fn)GetProcAddress(GetModuleHandleW(L"kernel32.dll"), "CreatePseudoConsole");
}

static close_pseudo_console_fn close_pseudo_console(void) {
  return (close_pseudo_console_fn)GetProcAddress(GetModuleHandleW(L"kernel32.dll"), "ClosePseudoConsole");
}

static resize_pseudo_console_fn resize_pseudo_console(void) {
  return (resize_pseudo_console_fn)GetProcAddress(GetModuleHandleW(L"kernel32.dll"), "ResizePseudoConsole");
}

static void close_handle(HANDLE handle) {
  if (handle && handle != INVALID_HANDLE_VALUE) CloseHandle(handle);
}

static HANDLE create_kill_job(void) {
  HANDLE job = CreateJobObjectW(NULL, NULL);
  if (!job) return NULL;
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits = { 0 };
  limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, &limits, sizeof(limits))) {
    close_handle(job);
    return NULL;
  }
  return job;
}

static int write_all(HANDLE handle, const char *buffer, DWORD length) {
  DWORD offset = 0;
  while (offset < length) {
    DWORD sent = 0;
    if (!WriteFile(handle, buffer + offset, length - offset, &sent, NULL) || sent == 0) return 0;
    offset += sent;
  }
  return 1;
}

static DWORD WINAPI relay_input(void *value) {
  relay_context *context = (relay_context *)value;
  char buffer[BUFFER_BYTES];
  DWORD got = 0;
  while (ReadFile(context->input, buffer, sizeof(buffer), &got, NULL) && got > 0) {
    if (!write_all(context->pty_input, buffer, got)) {
      InterlockedExchange(&context->relay_failure, 1);
      break;
    }
  }
  return 0;
}

static DWORD WINAPI relay_output(void *value) {
  relay_context *context = (relay_context *)value;
  char buffer[BUFFER_BYTES];
  DWORD got = 0;
  while (ReadFile(context->output, buffer, sizeof(buffer), &got, NULL) && got > 0) {
    if (!write_all(context->stdout_handle, buffer, got)) {
      InterlockedExchange(&context->relay_failure, 1);
      break;
    }
  }
  return 0;
}

static DWORD WINAPI relay_resize(void *value) {
  relay_context *context = (relay_context *)value;
  if (!context->resize || context->resize == INVALID_HANDLE_VALUE) return 0;
  char held[RESIZE_LINE_BYTES];
  size_t length = 0;
  DWORD got = 0;
  resize_pseudo_console_fn resize = resize_pseudo_console();
  if (!resize) {
    InterlockedExchange(&context->relay_failure, 1);
    return 0;
  }
  while (ReadFile(context->resize, held + length, (DWORD)(sizeof(held) - length), &got, NULL) && got > 0) {
    length += got;
    size_t start = 0;
    for (size_t index = 0; index < length; index += 1) {
      if (held[index] != '\n') continue;
      held[index] = 0;
      int columns = 0;
      int rows = 0;
      if (sscanf_s(held + start, "%d %d", &columns, &rows) == 2 && columns > 0 && rows > 0 && columns <= 4096 && rows <= 4096) {
        if (FAILED(resize(context->console, (COORD){ (SHORT)columns, (SHORT)rows }))) InterlockedExchange(&context->relay_failure, 1);
      }
      start = index + 1;
    }
    if (start > 0) {
      length -= start;
      memmove(held, held + start, length);
    }
    if (length == sizeof(held)) length = 0;
  }
  return 0;
}

static int command_length(wchar_t **argv, int argc) {
  size_t length = 1;
  for (int index = 0; index < argc; index += 1) {
    size_t count = wcslen(argv[index]);
    if (count > (SIZE_MAX - length - 3) / 2) return 0;
    length += count * 2 + 3;
  }
  return length > INT_MAX ? 0 : (int)length;
}

static int append_argument(wchar_t *command, int offset, int capacity, const wchar_t *source) {
  const size_t count = wcslen(source);
  if ((size_t)offset + count * 2 + 3 >= (size_t)capacity) return 0;
  command[offset++] = L'"';
  int slashes = 0;
  for (size_t index = 0; index < count; index += 1) {
    const wchar_t character = source[index];
    if (character == L'\\') {
      slashes += 1;
      continue;
    }
    if (character == L'"') {
      for (int repeat = 0; repeat < slashes * 2 + 1; repeat += 1) command[offset++] = L'\\';
      command[offset++] = L'"';
    } else {
      for (int repeat = 0; repeat < slashes; repeat += 1) command[offset++] = L'\\';
      command[offset++] = character;
    }
    slashes = 0;
  }
  for (int repeat = 0; repeat < slashes * 2; repeat += 1) command[offset++] = L'\\';
  command[offset++] = L'"';
  command[offset] = 0;
  return offset;
}

static wchar_t *make_command(wchar_t **argv, int argc) {
  const int capacity = command_length(argv, argc);
  if (!capacity) return NULL;
  wchar_t *command = (wchar_t *)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, (SIZE_T)capacity * sizeof(wchar_t));
  if (!command) return NULL;
  int offset = 0;
  for (int index = 0; index < argc; index += 1) {
    if (index > 0) command[offset++] = L' ';
    const int next = append_argument(command, offset, capacity, argv[index]);
    if (next <= offset) {
      HeapFree(GetProcessHeap(), 0, command);
      return NULL;
    }
    offset = next;
  }
  return command;
}

static void cancel_thread(HANDLE thread) {
  if (!thread) return;
  CancelSynchronousIo(thread);
  WaitForSingleObject(thread, INFINITE);
  CloseHandle(thread);
}

static void wait_thread(HANDLE thread) {
  if (!thread) return;
  WaitForSingleObject(thread, INFINITE);
  CloseHandle(thread);
}

static int parse_dimension(const wchar_t *value, int fallback) {
  if (!value || !*value) return fallback;
  wchar_t *end = NULL;
  long parsed = wcstol(value, &end, 10);
  return end && *end == 0 && parsed >= 1 && parsed <= 4096 ? (int)parsed : fallback;
}

static int run_pty(int columns, int rows, wchar_t **argv, int argc, HANDLE input, HANDLE stdout_handle, HANDLE resize_handle) {
  create_pseudo_console_fn create = create_pseudo_console();
  close_pseudo_console_fn close = close_pseudo_console();
  if (!create || !close || !resize_pseudo_console()) {
    fprintf(stderr, "Windows 10 version 1809 or newer is required for terminal sessions.\n");
    return 1;
  }
  SECURITY_ATTRIBUTES security = { sizeof(SECURITY_ATTRIBUTES), NULL, TRUE };
  HANDLE input_read = NULL;
  HANDLE input_write = NULL;
  HANDLE output_read = NULL;
  HANDLE output_write = NULL;
  if (!CreatePipe(&input_read, &input_write, &security, 0) || !CreatePipe(&output_read, &output_write, &security, 0)) {
    close_handle(input_read);
    close_handle(input_write);
    close_handle(output_read);
    close_handle(output_write);
    return 1;
  }
  if (!SetHandleInformation(input_write, HANDLE_FLAG_INHERIT, 0) || !SetHandleInformation(output_read, HANDLE_FLAG_INHERIT, 0)) {
    close_handle(input_read);
    close_handle(input_write);
    close_handle(output_read);
    close_handle(output_write);
    return 1;
  }
  COORD size = { (SHORT)columns, (SHORT)rows };
  HPCON console = NULL;
  if (FAILED(create(size, input_read, output_write, 0, &console))) {
    close_handle(input_read);
    close_handle(input_write);
    close_handle(output_read);
    close_handle(output_write);
    return 1;
  }
  close_handle(input_read);
  close_handle(output_write);

  wchar_t *command = make_command(argv, argc);
  if (!command) {
    close(console);
    close_handle(input_write);
    close_handle(output_read);
    return 1;
  }
  HANDLE job = create_kill_job();
  if (!job) {
    close(console);
    close_handle(input_write);
    close_handle(output_read);
    return 1;
  }
  SIZE_T attribute_size = 0;
  InitializeProcThreadAttributeList(NULL, 2, 0, &attribute_size);
  LPPROC_THREAD_ATTRIBUTE_LIST attributes = (LPPROC_THREAD_ATTRIBUTE_LIST)HeapAlloc(GetProcessHeap(), 0, attribute_size);
  HANDLE jobs[] = { job };
  if (!attributes || !InitializeProcThreadAttributeList(attributes, 2, 0, &attribute_size)
      || !UpdateProcThreadAttribute(attributes, 0, PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE, console, sizeof(console), NULL, NULL)
      || !UpdateProcThreadAttribute(attributes, 0, PROC_THREAD_ATTRIBUTE_JOB_LIST, jobs, sizeof(jobs), NULL, NULL)) {
    HeapFree(GetProcessHeap(), 0, attributes);
    HeapFree(GetProcessHeap(), 0, command);
    close_handle(job);
    close(console);
    close_handle(input_write);
    close_handle(output_read);
    return 1;
  }
  STARTUPINFOEXW startup = { 0 };
  startup.StartupInfo.cb = sizeof(startup);
  startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
  startup.lpAttributeList = attributes;
  PROCESS_INFORMATION process = { 0 };
  const BOOL started = CreateProcessW(NULL, command, NULL, NULL, FALSE, EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT, NULL, NULL, &startup.StartupInfo, &process);
  DeleteProcThreadAttributeList(attributes);
  HeapFree(GetProcessHeap(), 0, attributes);
  HeapFree(GetProcessHeap(), 0, command);
  if (!started) {
    close_handle(job);
    close(console);
    close_handle(input_write);
    close_handle(output_read);
    return 1;
  }
  CloseHandle(process.hThread);
  relay_context context = { input, output_read, stdout_handle, resize_handle, input_write, console, 0 };
  HANDLE input_thread = CreateThread(NULL, 0, relay_input, &context, 0, NULL);
  HANDLE output_thread = CreateThread(NULL, 0, relay_output, &context, 0, NULL);
  HANDLE resize_thread = CreateThread(NULL, 0, relay_resize, &context, 0, NULL);
  if (!input_thread || !output_thread || !resize_thread) {
    TerminateJobObject(job, 1);
    close_handle(job);
    WaitForSingleObject(process.hProcess, INFINITE);
    close(console);
    cancel_thread(input_thread);
    wait_thread(output_thread);
    cancel_thread(resize_thread);
    close_handle(input_write);
    close_handle(output_read);
    CloseHandle(process.hProcess);
    return 1;
  }
  WaitForSingleObject(process.hProcess, INFINITE);
  DWORD status = 1;
  GetExitCodeProcess(process.hProcess, &status);
  close_handle(job);
  close(console);
  cancel_thread(input_thread);
  cancel_thread(resize_thread);
  wait_thread(output_thread);
  close_handle(input_write);
  close_handle(output_read);
  CloseHandle(process.hProcess);
  if (InterlockedCompareExchange(&context.relay_failure, 0, 0) != 0) return 1;
  return (int)status;
}

static int self_test(void) {
  SECURITY_ATTRIBUTES security = { sizeof(SECURITY_ATTRIBUTES), NULL, TRUE };
  HANDLE input_read = NULL;
  HANDLE input_write = NULL;
  HANDLE output_read = NULL;
  HANDLE output_write = NULL;
  HANDLE resize_read = NULL;
  HANDLE resize_write = NULL;
  if (!CreatePipe(&input_read, &input_write, &security, 0) || !CreatePipe(&output_read, &output_write, &security, 0) || !CreatePipe(&resize_read, &resize_write, &security, 0)) {
    close_handle(input_read);
    close_handle(input_write);
    close_handle(output_read);
    close_handle(output_write);
    close_handle(resize_read);
    close_handle(resize_write);
    return 1;
  }
  if (!SetHandleInformation(input_write, HANDLE_FLAG_INHERIT, 0) || !SetHandleInformation(output_read, HANDLE_FLAG_INHERIT, 0) || !SetHandleInformation(resize_write, HANDLE_FLAG_INHERIT, 0)) {
    close_handle(input_read);
    close_handle(input_write);
    close_handle(output_read);
    close_handle(output_write);
    close_handle(resize_read);
    close_handle(resize_write);
    return 1;
  }
  const char input[] = "Emma\r";
  const char resize[] = "100 30\n";
  const DWORD input_length = (DWORD)strlen(input);
  const DWORD resize_length = (DWORD)strlen(resize);
  DWORD written = 0;
  if (!WriteFile(input_write, input, input_length, &written, NULL) || written != input_length || !WriteFile(resize_write, resize, resize_length, &written, NULL) || written != resize_length) {
    close_handle(input_read);
    close_handle(input_write);
    close_handle(output_read);
    close_handle(output_write);
    close_handle(resize_read);
    close_handle(resize_write);
    return 1;
  }
  close_handle(input_write);
  close_handle(resize_write);
  wchar_t *command[] = { L"powershell.exe", L"-NoLogo", L"-NoProfile", L"-Command", L"& { $value=$Host.UI.ReadLine(); Start-Sleep -Milliseconds 100; $size=$Host.UI.RawUI.WindowSize; Write-Output ('received:'+$value+':'+$size.Width+'x'+$size.Height+':'+([int][char]$args[0][0])) }", L"東京", NULL };
  const int status = run_pty(80, 24, command, 6, input_read, output_write, resize_read);
  close_handle(input_read);
  close_handle(output_write);
  close_handle(resize_read);
  char output[BUFFER_BYTES];
  DWORD got = 0;
  size_t length = 0;
  while (length + 1 < sizeof(output) && ReadFile(output_read, output + length, (DWORD)(sizeof(output) - length - 1), &got, NULL) && got > 0) length += got;
  close_handle(output_read);
  output[length] = 0;
  return status == 0 && strstr(output, "received:Emma:100x30:26481") != NULL ? 0 : 1;
}

int wmain(int argc, wchar_t **argv) {
  if (argc == 2 && wcscmp(argv[1], L"--self-test") == 0) return self_test();
  if (argc < 4) {
    fprintf(stderr, "usage: emma-pty <columns> <rows> <command> [argument...]\n");
    return 2;
  }
  int columns = parse_dimension(argv[1], 80);
  int rows = parse_dimension(argv[2], 24);
  return run_pty(columns, rows, &argv[3], argc - 3, GetStdHandle(STD_INPUT_HANDLE), GetStdHandle(STD_OUTPUT_HANDLE), (HANDLE)_get_osfhandle(3));
}
