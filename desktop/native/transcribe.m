/* Speech to text without a server: the recognizer macOS already ships.
 *
 * Emma's other route is llama.cpp on localhost, which is better but is two
 * downloads and a terminal. This is the zero-setup half of that choice — the same
 * on-device engine macOS dictation uses, reached through Speech.framework. It is a
 * helper rather than main-process code for the same reason `quick_ask.m` is: Node
 * cannot call AppKit, and a spawned binary is cheaper than a native module.
 *
 * On-device is not a preference here, it is the rule. `requiresOnDeviceRecognition`
 * stays YES, so a Mac whose locale has no downloaded model fails loudly rather than
 * quietly uploading the recording to Apple.
 *
 *   emma-transcribe --check [locale]   → prints "ready", or why not; exit 1 if not
 *   emma-transcribe <wav> [locale]     → prints the transcript on stdout
 *
 * Build: clang -O2 -fobjc-arc -framework Foundation -framework Speech
 */

#import <Foundation/Foundation.h>
#import <Speech/Speech.h>

/* Long enough for a few minutes of speech on a busy machine, short enough that a
   wedged recognizer gives the renderer its error back instead of hanging the hold. */
static const NSTimeInterval kTimeout = 120.0;

static int fail(NSString *why) {
  fprintf(stderr, "%s\n", why.UTF8String);
  return 1;
}

/**
 * Waits for a callback without blocking the thread it arrives on.
 *
 * Speech.framework delivers its handlers to the main queue, so a semaphore held on
 * main deadlocks — the recognizer finishes and its result never gets to run. Pumping
 * the run loop is the wait that lets the callback through. Returns NO on timeout.
 */
static BOOL pump(BOOL *flag) {
  NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:kTimeout];
  while (!*flag && [NSRunLoop.currentRunLoop runMode:NSDefaultRunLoopMode beforeDate:[NSDate dateWithTimeIntervalSinceNow:0.05]]) {
    if ([NSDate.date compare:deadline] == NSOrderedDescending) return NO;
  }
  return *flag;
}

/** Blocks on the TCC prompt. The first call is what raises it; later calls answer instantly. */
static SFSpeechRecognizerAuthorizationStatus authorize(void) {
  __block SFSpeechRecognizerAuthorizationStatus result = SFSpeechRecognizerAuthorizationStatusNotDetermined;
  __block BOOL answered = NO;
  [SFSpeechRecognizer requestAuthorization:^(SFSpeechRecognizerAuthorizationStatus status) {
    result = status;
    answered = YES;
  }];
  pump(&answered);
  return result;
}

/* Every on-device path here is the dictation engine, so the Dictation switch gates
   all of it — with it off the recognizer fails at the last moment with "Siri and
   Dictation are disabled", long after `--check` has said yes. There is no API for the
   switch, so read the pref the toggle writes.
   ponytail: undocumented pref key; if Apple renames it --check goes back to
   optimistic and the real error still arrives at dictation time. */
static BOOL dictationEnabled(void) {
  CFPropertyListRef value = CFPreferencesCopyAppValue(CFSTR("Dictation Enabled"), CFSTR("com.apple.assistant.support"));
  BOOL on = value && CFGetTypeID(value) == CFBooleanGetTypeID() && CFBooleanGetValue(value);
  if (value) CFRelease(value);
  return on;
}

/** Nil when speech recognition cannot run at all, with the reason in `why`. */
static SFSpeechRecognizer *recognizer(NSString *localeID, NSString **why) {
  switch (authorize()) {
    case SFSpeechRecognizerAuthorizationStatusAuthorized: break;
    case SFSpeechRecognizerAuthorizationStatusDenied: *why = @"Speech recognition is denied for Emma in System Settings → Privacy & Security → Speech Recognition."; return nil;
    case SFSpeechRecognizerAuthorizationStatusRestricted: *why = @"Speech recognition is restricted on this Mac."; return nil;
    default: *why = @"Speech recognition was not authorized."; return nil;
  }
  NSLocale *locale = localeID.length ? [NSLocale localeWithLocaleIdentifier:localeID] : NSLocale.currentLocale;
  SFSpeechRecognizer *speech = [[SFSpeechRecognizer alloc] initWithLocale:locale];
  if (!speech) { *why = [NSString stringWithFormat:@"macOS has no speech recognizer for %@.", locale.localeIdentifier]; return nil; }
  if (!speech.isAvailable) { *why = @"The macOS speech recognizer is not available right now."; return nil; }
  // Without the downloaded model, an on-device request would either fail or — worse —
  // be answered by Apple's servers. Say so instead.
  if (!speech.supportsOnDeviceRecognition) { *why = [NSString stringWithFormat:@"%@ has no on-device speech model. Add the language under System Settings → Keyboard → Dictation.", locale.localeIdentifier]; return nil; }
  if (!dictationEnabled()) { *why = @"Dictation is off. Turn it on under System Settings → Keyboard → Dictation; macOS downloads the on-device model the first time."; return nil; }
  return speech;
}

int main(int argc, const char *argv[]) { @autoreleasepool {
  NSString *path = argc > 1 ? @(argv[1]) : nil;
  NSString *localeID = argc > 2 ? @(argv[2]) : nil;
  if (!path.length) return fail(@"usage: emma-transcribe <audio-file>|--check [locale]");

  __block NSString *why = nil;
  SFSpeechRecognizer *speech = recognizer(localeID, &why);
  if (!speech) return fail(why);
  if ([path isEqualToString:@"--check"]) { printf("ready\n"); return 0; }
  if (![NSFileManager.defaultManager fileExistsAtPath:path]) return fail(@"That recording is gone.");

  SFSpeechURLRecognitionRequest *request = [[SFSpeechURLRecognitionRequest alloc] initWithURL:[NSURL fileURLWithPath:path]];
  request.requiresOnDeviceRecognition = YES;
  request.shouldReportPartialResults = NO;
  request.taskHint = SFSpeechRecognitionTaskHintDictation;
  if (@available(macOS 13.0, *)) request.addsPunctuation = YES;

  __block NSString *text = nil;
  __block BOOL done = NO;
  [speech recognitionTaskWithRequest:request resultHandler:^(SFSpeechRecognitionResult *result, NSError *error) {
    // Partials are off, so the only callbacks worth acting on are the final one and a failure.
    if (error) { why = error.localizedDescription; done = YES; return; }
    if (!result.isFinal) return;
    text = result.bestTranscription.formattedString;
    done = YES;
  }];
  if (!pump(&done)) return fail(@"The macOS recognizer did not answer in time.");
  if (!text) return fail(why ?: @"The macOS recognizer heard nothing.");
  printf("%s\n", text.UTF8String);
  return 0;
}}
