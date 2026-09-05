#import <AppKit/AppKit.h>
#import <ApplicationServices/ApplicationServices.h>
#include <assert.h>
#include <limits.h>
#include <libproc.h>
#include <math.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

static const NSUInteger max_elements = 400;
static const NSUInteger max_state_bytes = 23000;
static const NSUInteger max_input_bytes = 65536;
static const NSUInteger max_text_characters = 4096;
static volatile sig_atomic_t cancelled = 0;
static NSTimeInterval operation_deadline = 0;

static void cancel_input(int signal_number) {
    (void)signal_number;
    cancelled = 1;
}

static BOOL within_deadline(void) {
    return !cancelled && [NSDate timeIntervalSinceReferenceDate] < operation_deadline;
}

static BOOL finite_number(id value, double *number) {
    if (![value isKindOfClass:[NSNumber class]] || CFGetTypeID((__bridge CFTypeRef)value) == CFBooleanGetTypeID()) return NO;
    *number = [value doubleValue];
    return isfinite(*number);
}

static BOOL integer_in_range(id value, double minimum, double maximum) {
    double number = 0;
    return finite_number(value, &number) && number >= minimum && number <= maximum && floor(number) == number;
}

static BOOL bounded_string(id value, NSUInteger maximum, BOOL empty_allowed) {
    return [value isKindOfClass:[NSString class]] && ((NSString *)value).length <= maximum
        && (empty_allowed || ((NSString *)value).length > 0) && [(NSString *)value rangeOfString:@"\0"].location == NSNotFound;
}

static NSDictionary *failure(NSString *message) {
    return @{@"ok": @NO, @"error": message};
}

static void write_result(NSDictionary *result) {
    NSData *data = [NSJSONSerialization dataWithJSONObject:result options:0 error:NULL];
    if (!data) data = [@"{\"ok\":false,\"error\":\"The app helper could not serialize its response\"}" dataUsingEncoding:NSUTF8StringEncoding];
    fwrite(data.bytes, 1, data.length, stdout);
    fputc('\n', stdout);
    fflush(stdout);
}

static void write_cursor(NSDictionary *cursor) {
    write_result(@{@"event": @"cursor", @"cursor": cursor ?: NSNull.null});
}

static BOOL matching_cursor(NSDictionary *before, NSDictionary *after) {
    return before && after && [before isEqualToDictionary:after];
}

static uint64_t process_birth(pid_t pid) {
    struct proc_bsdinfo info = {0};
    if (proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, sizeof(info)) != sizeof(info)
        || info.pbi_pid != (uint32_t)pid || (info.pbi_flags & PROC_FLAG_INEXIT)) return 0;
    return info.pbi_start_tvsec * 1000000 + info.pbi_start_tvusec;
}

static NSString *emma_binary_path(pid_t blocked_pid) {
    char buffer[PROC_PIDPATHINFO_MAXSIZE] = {0};
    int length = proc_pidpath(blocked_pid, buffer, sizeof(buffer));
    return length > 0 ? [[NSString alloc] initWithBytes:buffer length:(NSUInteger)length encoding:NSUTF8StringEncoding] : nil;
}

static BOOL emma_binary_name(NSString *path) {
    NSString *stem = path.lastPathComponent.stringByDeletingPathExtension.lowercaseString;
    return [@[@"emma", @"emma-host", @"emma-cli", @"emma-pty", @"emma-computer", @"emma-option-tap", @"emma-transcribe"] containsObject:stem];
}

static BOOL emma_owned(NSString *bundle_path, pid_t pid, pid_t blocked_pid) {
    if (pid == getpid() || pid == blocked_pid || !bundle_path.length) return YES;
    if (emma_binary_name(bundle_path)) return YES;
    NSString *emma = emma_binary_path(blocked_pid);
    return emma.length && ([emma isEqualToString:bundle_path] || [emma hasPrefix:[bundle_path stringByAppendingString:@"/"]]);
}

static NSDictionary *application_identity(NSRunningApplication *application) {
    NSString *path = application.bundleURL.URLByResolvingSymlinksInPath.path;
    if (!application || application.terminated || application.processIdentifier <= 0 || !application.bundleIdentifier.length
        || !path.length || application.activationPolicy != NSApplicationActivationPolicyRegular) return nil;
    uint64_t birth = process_birth(application.processIdentifier);
    if (!birth) return nil;
    return @{@"id": application.bundleIdentifier, @"name": application.localizedName ?: application.bundleIdentifier,
        @"pid": @(application.processIdentifier), @"path": path, @"launchedAt": @(birth / 1000.0)};
}

static BOOL valid_identity(id value, pid_t blocked_pid) {
    if (![value isKindOfClass:[NSDictionary class]] || ((NSDictionary *)value).count != 5) return NO;
    NSDictionary *identity = value;
    NSString *identifier = identity[@"id"];
    if (!bounded_string(identifier, 255, NO)) return NO;
    NSCharacterSet *allowed = [NSCharacterSet characterSetWithCharactersInString:@"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_.-"];
    double launched = 0;
    return [identifier rangeOfCharacterFromSet:allowed.invertedSet].location == NSNotFound
        && [NSCharacterSet.alphanumericCharacterSet characterIsMember:[identifier characterAtIndex:0]]
        && bounded_string(identity[@"name"], 256, NO)
        && bounded_string(identity[@"path"], 4096, NO) && [identity[@"path"] hasPrefix:@"/"]
        && finite_number(identity[@"launchedAt"], &launched) && launched > 0
        && integer_in_range(identity[@"pid"], 1, INT_MAX)
        && !emma_owned(identity[@"path"], (pid_t)[identity[@"pid"] intValue], blocked_pid);
}

static NSDictionary *list_applications(pid_t blocked_pid) {
    NSMutableArray *applications = [NSMutableArray array];
    for (NSRunningApplication *application in NSWorkspace.sharedWorkspace.runningApplications) {
        NSDictionary *identity = application_identity(application);
        if (identity && valid_identity(identity, blocked_pid)) [applications addObject:identity];
        if (applications.count == 128) break;
    }
    [applications sortUsingComparator:^NSComparisonResult(NSDictionary *left, NSDictionary *right) {
        return [left[@"name"] localizedCaseInsensitiveCompare:right[@"name"]];
    }];
    return @{@"ok": @YES, @"apps": applications};
}

static BOOL resolvable_app_name(NSString *name) {
    if (name.length == 0 || name.length > 128 || [name rangeOfString:@"/"].location != NSNotFound) return NO;
    NSCharacterSet *control = NSCharacterSet.controlCharacterSet;
    return [name rangeOfCharacterFromSet:control].location == NSNotFound
        && ![name hasPrefix:@" "] && ![name hasSuffix:@" "];
}

static NSURL *installed_application_url(NSString *name) {
    if (!resolvable_app_name(name)) return nil;
    NSURL *identified = [NSWorkspace.sharedWorkspace URLForApplicationWithBundleIdentifier:name];
    if (identified) return identified;
    NSArray<NSString *> *directories = @[@"/Applications", @"/Applications/Utilities", @"/System/Applications",
        @"/System/Applications/Utilities", [NSHomeDirectory() stringByAppendingPathComponent:@"Applications"]];
    NSURL *near_match = nil;
    NSUInteger near_matches = 0;
    for (NSString *directory in directories) {
        for (NSString *entry in [NSFileManager.defaultManager contentsOfDirectoryAtPath:directory error:NULL]) {
            if (![entry.pathExtension isEqualToString:@"app"]) continue;
            NSURL *url = [NSURL fileURLWithPath:[directory stringByAppendingPathComponent:entry]];
            NSString *stem = entry.stringByDeletingPathExtension;
            if ([stem caseInsensitiveCompare:name] == NSOrderedSame) return url;
            if ([stem.lowercaseString hasPrefix:name.lowercaseString]) {
                near_match = url;
                near_matches += 1;
            }
        }
    }
    return near_matches == 1 ? near_match : nil;
}

static NSString *application_display_name(NSURL *url) {
    NSBundle *bundle = [NSBundle bundleWithURL:url];
    NSString *name = bundle.infoDictionary[@"CFBundleDisplayName"] ?: bundle.infoDictionary[@"CFBundleName"];
    return name.length ? name : url.lastPathComponent.stringByDeletingPathExtension;
}

static NSDictionary *launch_target(NSURL *url) {
    return @{@"name": application_display_name(url), @"target": url.URLByResolvingSymlinksInPath.path};
}

static NSRunningApplication *open_application(NSURL *url) {
    NSWorkspaceOpenConfiguration *configuration = NSWorkspaceOpenConfiguration.configuration;
    configuration.activates = YES;
    configuration.addsToRecentItems = NO;
    __block NSRunningApplication *opened = nil;
    __block BOOL finished = NO;
    [NSWorkspace.sharedWorkspace openApplicationAtURL:url configuration:configuration completionHandler:^(NSRunningApplication *application, NSError *error) {
        (void)error;
        opened = application;
        finished = YES;
    }];
    NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:12];
    while (!cancelled && [NSDate.date compare:deadline] == NSOrderedAscending) {
        [NSRunLoop.currentRunLoop runMode:NSDefaultRunLoopMode beforeDate:[NSDate dateWithTimeIntervalSinceNow:0.1]];
        if (finished && opened && application_identity(opened)) return opened;
        if (finished && !opened) return nil;
    }
    return finished ? opened : nil;
}

static id attribute(AXUIElementRef element, CFStringRef name) {
    if (!element || !within_deadline()) return nil;
    AXUIElementSetMessagingTimeout(element, 0.2);
    CFTypeRef value = NULL;
    if (AXUIElementCopyAttributeValue(element, name, &value) != kAXErrorSuccess || !value) {
        if (value) CFRelease(value);
        return nil;
    }
    return CFBridgingRelease(value);
}

static NSString *string_attribute(AXUIElementRef element, CFStringRef name) {
    id value = attribute(element, name);
    return [value isKindOfClass:[NSString class]] && [value length] <= 65536 ? value : nil;
}

static BOOL element_in_process(AXUIElementRef element, pid_t pid) {
    pid_t actual = 0;
    return element && CFGetTypeID(element) == AXUIElementGetTypeID()
        && AXUIElementGetPid(element, &actual) == kAXErrorSuccess && actual == pid;
}

static BOOL valid_bounds(CGRect bounds) {
    return isfinite(bounds.origin.x) && isfinite(bounds.origin.y) && isfinite(bounds.size.width) && isfinite(bounds.size.height)
        && fabs(bounds.origin.x) <= 100000 && fabs(bounds.origin.y) <= 100000
        && bounds.size.width > 0 && bounds.size.width <= 16384 && bounds.size.height > 0 && bounds.size.height <= 16384
        && fabs(CGRectGetMaxX(bounds)) <= 100000 && fabs(CGRectGetMaxY(bounds)) <= 100000;
}

static CGRect clipped_control(CGRect control, CGRect window, CGRect display) {
    if (!valid_bounds(control) || !valid_bounds(window) || !valid_bounds(display)) return CGRectNull;
    CGRect clipped = CGRectIntersection(CGRectIntersection(control, window), display);
    return valid_bounds(clipped) ? clipped : CGRectNull;
}

static BOOL matching_bounds(CGRect left, CGRect right) {
    return valid_bounds(left) && valid_bounds(right) && fabs(left.origin.x - right.origin.x) <= 0.5
        && fabs(left.origin.y - right.origin.y) <= 0.5 && fabs(left.size.width - right.size.width) <= 0.5
        && fabs(left.size.height - right.size.height) <= 0.5;
}

static BOOL element_bounds(AXUIElementRef element, CGRect *bounds) {
    id position = attribute(element, kAXPositionAttribute);
    id size = attribute(element, kAXSizeAttribute);
    CGPoint point = CGPointZero;
    CGSize dimensions = CGSizeZero;
    if (!position || !size || CFGetTypeID((__bridge CFTypeRef)position) != AXValueGetTypeID()
        || CFGetTypeID((__bridge CFTypeRef)size) != AXValueGetTypeID()
        || AXValueGetType((__bridge AXValueRef)position) != kAXValueCGPointType
        || AXValueGetType((__bridge AXValueRef)size) != kAXValueCGSizeType
        || !AXValueGetValue((__bridge AXValueRef)position, kAXValueCGPointType, &point)
        || !AXValueGetValue((__bridge AXValueRef)size, kAXValueCGSizeType, &dimensions)) return NO;
    *bounds = CGRectMake(point.x, point.y, dimensions.width, dimensions.height);
    return valid_bounds(*bounds);
}

static NSDictionary *matching_window(NSArray *windows, pid_t pid, CGRect bounds) {
    if (!windows || windows.count > 4096 || !valid_bounds(bounds)) return nil;
    NSDictionary *match = nil;
    for (id item in windows) {
        if (![item isKindOfClass:[NSDictionary class]]) continue;
        NSDictionary *window = item;
        id frame = window[(__bridge NSString *)kCGWindowBounds];
        CGRect actual = CGRectNull;
        if (!integer_in_range(window[(__bridge NSString *)kCGWindowOwnerPID], 1, INT_MAX)
            || [window[(__bridge NSString *)kCGWindowOwnerPID] intValue] != pid
            || !integer_in_range(window[(__bridge NSString *)kCGWindowNumber], 1, UINT32_MAX)
            || ![frame isKindOfClass:[NSDictionary class]]
            || !CGRectMakeWithDictionaryRepresentation((__bridge CFDictionaryRef)frame, &actual)
            || !matching_bounds(bounds, actual)) continue;
        if (match) return nil;
        match = window;
    }
    double alpha = 0;
    if (!match || ![match[(__bridge NSString *)kCGWindowIsOnscreen] isEqual:@YES]
        || !finite_number(match[(__bridge NSString *)kCGWindowAlpha], &alpha) || alpha <= 0 || alpha > 1) return nil;
    return match;
}

static BOOL allowed_role(NSString *role) {
    return role.length > 0 && ![role isEqualToString:(__bridge NSString *)kAXMenuBarRole];
}

static BOOL excluded_element(AXUIElementRef element) {
    if (!allowed_role(string_attribute(element, kAXRoleAttribute))) return YES;
    CFStringRef attributes[] = {kAXSubroleAttribute, (__bridge CFStringRef)NSAccessibilityContainsProtectedContentAttribute};
    for (NSUInteger index = 0; index < 2; index += 1) {
        if (!within_deadline()) return YES;
        AXUIElementSetMessagingTimeout(element, 0.2);
        CFTypeRef value = NULL;
        AXError error = AXUIElementCopyAttributeValue(element, attributes[index], &value);
        BOOL protected = NO;
        if (error == kAXErrorSuccess && value) {
            if (index == 0) protected = CFGetTypeID(value) != CFStringGetTypeID() || CFEqual(value, kAXSecureTextFieldSubrole);
            else protected = ![(__bridge id)value isKindOfClass:[NSNumber class]] || [(__bridge NSNumber *)value boolValue];
        } else if (error != kAXErrorNoValue && error != kAXErrorAttributeUnsupported) protected = YES;
        if (value) CFRelease(value);
        if (protected) return YES;
    }
    return NO;
}

static NSDictionary *element_identity(AXUIElementRef element) {
    return @{@"role": string_attribute(element, kAXRoleAttribute) ?: @"",
        @"subrole": string_attribute(element, kAXSubroleAttribute) ?: @"",
        @"title": string_attribute(element, kAXTitleAttribute) ?: @"",
        @"identifier": string_attribute(element, kAXIdentifierAttribute) ?: @""};
}

static BOOL settable(AXUIElementRef element, CFStringRef name) {
    if (!within_deadline()) return NO;
    Boolean result = false;
    return AXUIElementIsAttributeSettable(element, name, &result) == kAXErrorSuccess && result;
}

static NSArray *action_names(AXUIElementRef element) {
    if (!within_deadline()) return @[];
    CFArrayRef actions = NULL;
    if (AXUIElementCopyActionNames(element, &actions) != kAXErrorSuccess || !actions) {
        if (actions) CFRelease(actions);
        return @[];
    }
    return CFBridgingRelease(actions);
}

static NSString *quoted_text(NSString *text) {
    NSUInteger length = MIN(text.length, (NSUInteger)240);
    if (length && CFStringIsSurrogateHighCharacter([text characterAtIndex:length - 1])) length -= 1;
    NSString *clipped = [text substringToIndex:length];
    NSData *json = [NSJSONSerialization dataWithJSONObject:clipped options:NSJSONWritingFragmentsAllowed error:NULL];
    return json ? [[NSString alloc] initWithData:json encoding:NSUTF8StringEncoding] : @"\"\"";
}

static BOOL named_key(NSString *name, CGKeyCode *key) {
    NSDictionary *keys = @{@"return": @36, @"enter": @36, @"tab": @48, @"space": @49, @"backspace": @51,
        @"delete": @117, @"escape": @53, @"left": @123, @"right": @124, @"down": @125, @"up": @126,
        @"home": @115, @"end": @119, @"pageup": @116, @"pagedown": @121};
    NSNumber *value = keys[name.lowercaseString];
    if (!value) return NO;
    *key = (CGKeyCode)value.unsignedShortValue;
    return YES;
}

static BOOL validate_action(id value) {
    if (![value isKindOfClass:[NSDictionary class]]) return NO;
    NSDictionary *object = value;
    NSString *action = object[@"action"];
    if (![action isKindOfClass:[NSString class]]) return NO;
    if ([action isEqualToString:@"get_app_state"]) return object.count == 1;
    if (!bounded_string(object[@"snapshot"], 64, NO) || !integer_in_range(object[@"element_index"], 0, max_elements - 1)) return NO;
    if ([action isEqualToString:@"click"]) return object.count == 3;
    if ([action isEqualToString:@"set_value"]) return object.count == 4 && bounded_string(object[@"value"], max_text_characters, YES);
    if ([action isEqualToString:@"type_text"]) return object.count == 4 && bounded_string(object[@"text"], max_text_characters, NO);
    if ([action isEqualToString:@"key"]) {
        CGKeyCode key = 0;
        return object.count == 4 && bounded_string(object[@"key"], 32, NO) && named_key(object[@"key"], &key);
    }
    return [action isEqualToString:@"scroll"] && object.count == 5
        && [@[@"up", @"down", @"left", @"right"] containsObject:object[@"direction"] ?: NSNull.null]
        && integer_in_range(object[@"amount"], 1, 10);
}

static NSString *inserting_text(NSString *value, CFRange range, NSString *text) {
    if (range.location < 0 || range.length < 0 || (NSUInteger)range.location > value.length
        || (NSUInteger)range.length > value.length - (NSUInteger)range.location
        || value.length - (NSUInteger)range.length + text.length > 65536) return nil;
    NSUInteger start = (NSUInteger)range.location;
    NSUInteger end = start + (NSUInteger)range.length;
    if ((start && start < value.length && CFStringIsSurrogateLowCharacter([value characterAtIndex:start]))
        || (end && end < value.length && CFStringIsSurrogateLowCharacter([value characterAtIndex:end]))) return nil;
    return [value stringByReplacingCharactersInRange:NSMakeRange((NSUInteger)range.location, (NSUInteger)range.length) withString:text];
}

static NSDictionary *mutation_result(AXError error) {
    if (error == kAXErrorSuccess) return @{@"ok": @YES, @"text": @"The app accepted the action. Get app state again to verify its effect."};
    if (error == kAXErrorCannotComplete) return failure(@"The app did not confirm the action. It may already have happened; get app state before considering another action. Do not retry automatically.");
    if (error == kAXErrorInvalidUIElement) return failure(@"The control no longer exists. Get app state again.");
    return failure(@"This control does not support the requested background action. No foreground or global-input fallback was used.");
}

@interface AppSession : NSObject
- (instancetype)initWithIdentity:(NSDictionary *)identity blockedPID:(pid_t)blocked_pid;
- (NSDictionary *)handle:(NSDictionary *)request;
@end

@implementation AppSession {
    NSDictionary *_identity;
    NSRunningApplication *_application;
    uint64_t _birth;
    AXUIElementRef _root;
    NSMutableArray *_elements;
    NSMutableArray<NSDictionary *> *_identities;
    NSString *_snapshot;
    NSTimeInterval _snapshot_at;
    NSUInteger _state_bytes;
    BOOL _truncated;
    NSDictionary *_cursor;
    id _cursor_element;
}

- (instancetype)initWithIdentity:(NSDictionary *)identity blockedPID:(pid_t)blocked_pid {
    self = [super init];
    if (!self || !valid_identity(identity, blocked_pid)) return nil;
    _identity = identity;
    pid_t pid = [identity[@"pid"] intValue];
    _application = [NSRunningApplication runningApplicationWithProcessIdentifier:pid];
    _birth = process_birth(pid);
    if (!_birth || ![application_identity(_application) isEqualToDictionary:identity]) return nil;
    _root = AXUIElementCreateApplication(pid);
    _elements = [NSMutableArray array];
    _identities = [NSMutableArray array];
    return self;
}

- (void)dealloc {
    if (_root) CFRelease(_root);
}

- (BOOL)validApplication {
    if (cancelled) return NO;
    [[NSRunLoop currentRunLoop] runUntilDate:[NSDate dateWithTimeIntervalSinceNow:0.001]];
    pid_t pid = [_identity[@"pid"] intValue];
    NSRunningApplication *current = [NSRunningApplication runningApplicationWithProcessIdentifier:pid];
    return _birth != 0 && process_birth(pid) == _birth && current && !current.terminated
        && [_application isEqual:current] && [application_identity(current) isEqualToDictionary:_identity];
}

- (BOOL)allowedElement:(AXUIElementRef)element {
    pid_t pid = [_identity[@"pid"] intValue];
    if (!element_in_process(element, pid) || excluded_element(element)) return NO;
    id parent = (__bridge id)element;
    for (NSUInteger depth = 0; depth < 32 && within_deadline(); depth += 1) {
        AXUIElementRef ancestor = (__bridge AXUIElementRef)parent;
        if (!element_in_process(ancestor, pid) || excluded_element(ancestor)) return NO;
        if (CFEqual(ancestor, _root)) return YES;
        parent = attribute(ancestor, kAXParentAttribute);
        if (!parent || CFGetTypeID((__bridge CFTypeRef)parent) != AXUIElementGetTypeID()) return NO;
    }
    return NO;
}

- (NSDictionary *)cursorForElement:(AXUIElementRef)element {
    pid_t pid = [_identity[@"pid"] intValue];
    if (!element_in_process(element, pid) || !within_deadline()) return nil;
    id window = [string_attribute(element, kAXRoleAttribute) isEqualToString:(__bridge NSString *)kAXWindowRole]
        ? (__bridge id)element : attribute(element, kAXWindowAttribute);
    if (!window || CFGetTypeID((__bridge CFTypeRef)window) != AXUIElementGetTypeID()
        || !element_in_process((__bridge AXUIElementRef)window, pid)
        || ![self allowedElement:(__bridge AXUIElementRef)window]
        || ![string_attribute((__bridge AXUIElementRef)window, kAXRoleAttribute) isEqualToString:(__bridge NSString *)kAXWindowRole]
        || ![attribute((__bridge AXUIElementRef)window, kAXMinimizedAttribute) isEqual:@NO]) return nil;
    CGRect control = CGRectNull;
    CGRect ax_window = CGRectNull;
    if (!element_bounds(element, &control) || !element_bounds((__bridge AXUIElementRef)window, &ax_window)) return nil;
    NSArray *windows = CFBridgingRelease(CGWindowListCopyWindowInfo(kCGWindowListOptionAll | kCGWindowListExcludeDesktopElements, kCGNullWindowID));
    NSDictionary *match = matching_window(windows, pid, ax_window);
    CGRect bounds = CGRectNull;
    if (!match || !within_deadline() || !CGRectMakeWithDictionaryRepresentation((__bridge CFDictionaryRef)match[(__bridge NSString *)kCGWindowBounds], &bounds)) return nil;
    CGDirectDisplayID displays[32];
    uint32_t count = 0;
    if (CGGetActiveDisplayList(0, NULL, &count) != kCGErrorSuccess || !count || count > 32
        || CGGetActiveDisplayList(32, displays, &count) != kCGErrorSuccess) return nil;
    CGRect best = CGRectNull;
    CGFloat best_area = 0;
    for (uint32_t index = 0; index < count; index += 1) {
        CGRect clipped = clipped_control(CGRectIntersection(control, ax_window), bounds, CGDisplayBounds(displays[index]));
        CGFloat area = CGRectIsNull(clipped) ? 0 : clipped.size.width * clipped.size.height;
        if (area > best_area) {
            best = clipped;
            best_area = area;
        }
    }
    if (!best_area || !within_deadline()) return nil;
    CGPoint anchor = CGPointMake(CGRectGetMidX(best), CGRectGetMidY(best));
    if (anchor.x <= CGRectGetMinX(best) || anchor.x >= CGRectGetMaxX(best)
        || anchor.y <= CGRectGetMinY(best) || anchor.y >= CGRectGetMaxY(best)) return nil;
    return @{@"windowId": match[(__bridge NSString *)kCGWindowNumber],
        @"bounds": @{@"x": @(bounds.origin.x), @"y": @(bounds.origin.y), @"width": @(bounds.size.width), @"height": @(bounds.size.height)},
        @"x": @(anchor.x), @"y": @(anchor.y)};
}

- (void)showCursor:(NSDictionary *)cursor element:(AXUIElementRef)element {
    _cursor = cursor;
    _cursor_element = cursor ? (__bridge id)element : nil;
    write_cursor(cursor);
}

- (void)appendElement:(AXUIElementRef)element depth:(NSUInteger)depth text:(NSMutableString *)text {
    if (depth > 18 || _elements.count >= max_elements || _truncated || !within_deadline()
        || !element_in_process(element, [_identity[@"pid"] intValue]) || [_elements containsObject:(__bridge id)element]
        || excluded_element(element)) return;
    NSDictionary *identity = element_identity(element);
    if (![identity[@"role"] length] || !within_deadline()) return;
    NSUInteger index = _elements.count;
    [_elements addObject:(__bridge id)element];
    [_identities addObject:identity];
    NSMutableString *line = [NSMutableString stringWithFormat:@"%*s[%lu] %@", (int)MIN(depth, (NSUInteger)10) * 2, "", (unsigned long)index, identity[@"role"]];
    NSString *title = identity[@"title"];
    NSString *description = string_attribute(element, kAXDescriptionAttribute);
    if (title.length) [line appendFormat:@" title=%@", quoted_text(title)];
    if (description.length && ![description isEqualToString:title]) [line appendFormat:@" description=%@", quoted_text(description)];
    id value = attribute(element, kAXValueAttribute);
    if ([value isKindOfClass:[NSString class]] && [value length]) [line appendFormat:@" value=%@", quoted_text(value)];
    else if ([value isKindOfClass:[NSNumber class]]) [line appendFormat:@" value=%@", value];
    if ([attribute(element, kAXEnabledAttribute) isEqual:@NO]) [line appendString:@" disabled"];
    if ([attribute(element, kAXFocusedAttribute) isEqual:@YES]) [line appendString:@" focused"];
    NSArray *actions = action_names(element);
    if ([actions containsObject:(__bridge NSString *)kAXPressAction]) [line appendString:@" clickable"];
    if (settable(element, kAXValueAttribute)) [line appendString:@" editable_value"];
    [line appendString:@"\n"];
    NSUInteger bytes = [line lengthOfBytesUsingEncoding:NSUTF8StringEncoding];
    if (_state_bytes + bytes > max_state_bytes) {
        [_elements removeLastObject];
        [_identities removeLastObject];
        _truncated = YES;
        return;
    }
    [text appendString:line];
    _state_bytes += bytes;
    CFIndex count = 0;
    if (!within_deadline() || AXUIElementGetAttributeValueCount(element, kAXChildrenAttribute, &count) != kAXErrorSuccess || count <= 0) return;
    CFArrayRef children = NULL;
    if (AXUIElementCopyAttributeValues(element, kAXChildrenAttribute, 0, MIN(count, (CFIndex)(max_elements - _elements.count)), &children) != kAXErrorSuccess || !children) {
        if (children) CFRelease(children);
        return;
    }
    for (id child in (__bridge NSArray *)children) {
        if (CFGetTypeID((__bridge CFTypeRef)child) == AXUIElementGetTypeID()) [self appendElement:(__bridge AXUIElementRef)child depth:depth + 1 text:text];
        if (!within_deadline() || _elements.count >= max_elements || _truncated) break;
    }
    CFRelease(children);
}

- (NSDictionary *)state {
    _snapshot = nil;
    [_elements removeAllObjects];
    [_identities removeAllObjects];
    NSMutableString *text = [NSMutableString stringWithFormat:@"App: %@ (%@). Background accessibility controls only.\n", _identity[@"name"], _identity[@"id"]];
    _state_bytes = [text lengthOfBytesUsingEncoding:NSUTF8StringEncoding];
    _truncated = NO;
    [self appendElement:_root depth:0 text:text];
    if (![self validApplication]) return failure(@"The approved app has closed or changed. Open it and request approval again.");
    if (cancelled) return failure(@"App control was stopped.");
    if (_elements.count <= 1) return failure(@"The app exposes no accessible controls. Open its window first. Emma will not activate it or use global input.");
    _snapshot = NSUUID.UUID.UUIDString;
    _snapshot_at = [NSDate timeIntervalSinceReferenceDate];
    if (!within_deadline() || _elements.count >= max_elements || _truncated) [text appendString:@"State is truncated by the time, size, or element limit.\n"];
    [text appendFormat:@"Snapshot: %@. Use this snapshot and an element_index for one action, then get_app_state again. Menu bars and secure controls are omitted.\n", _snapshot];
    return @{@"ok": @YES, @"snapshot": _snapshot, @"text": text};
}

- (NSDictionary *)setValue:(NSString *)value element:(AXUIElementRef)element expected:(NSString *)expected {
    if (!settable(element, kAXValueAttribute)) return failure(@"This control's value cannot be set through accessibility. No keyboard fallback was used.");
    NSDictionary *cursor = [self cursorForElement:element];
    if (![self validApplication] || ![self allowedElement:element] || !within_deadline()) return failure(@"The approved app or control changed. Get app state again.");
    if (expected && ![string_attribute(element, kAXValueAttribute) isEqualToString:expected]) return failure(@"The text changed while preparing the insertion. Nothing was written; get app state again.");
    if (!within_deadline()) return failure(@"App control was stopped or timed out. No text was written.");
    AXUIElementSetMessagingTimeout(element, 1.0);
    [self showCursor:cursor element:element];
    AXError error = AXUIElementSetAttributeValue(element, kAXValueAttribute, (__bridge CFStringRef)value);
    if (error != kAXErrorSuccess) return mutation_result(error);
    NSString *actual = string_attribute(element, kAXValueAttribute);
    if (![actual isEqualToString:value]) return failure(@"The app accepted a value change, but its resulting text could not be verified. Get app state; do not retry automatically.");
    return @{@"ok": @YES, @"text": @"The control's text was changed and its value was verified. Get app state again before another action."};
}

- (NSDictionary *)scroll:(NSDictionary *)request element:(AXUIElementRef)element {
    NSString *direction = request[@"direction"];
    BOOL horizontal = [direction isEqualToString:@"left"] || [direction isEqualToString:@"right"];
    BOOL increasing = [direction isEqualToString:@"down"] || [direction isEqualToString:@"right"];
    id scrollbar = (__bridge id)element;
    if (![string_attribute(element, kAXRoleAttribute) isEqualToString:(__bridge NSString *)kAXScrollBarRole]) {
        scrollbar = attribute(element, horizontal ? kAXHorizontalScrollBarAttribute : kAXVerticalScrollBarAttribute);
    }
    if (!scrollbar || CFGetTypeID((__bridge CFTypeRef)scrollbar) != AXUIElementGetTypeID()
        || ![self allowedElement:(__bridge AXUIElementRef)scrollbar]) return failure(@"Choose an accessible scroll area or scrollbar. This control has no supported scrollbar.");
    AXUIElementRef bar = (__bridge AXUIElementRef)scrollbar;
    NSString *orientation = string_attribute(bar, kAXOrientationAttribute);
    NSString *expected = horizontal ? (__bridge NSString *)kAXHorizontalOrientationValue : (__bridge NSString *)kAXVerticalOrientationValue;
    if (![orientation isEqualToString:expected]) return failure(@"The scrollbar does not match the requested direction.");
    double value = 0;
    double minimum = 0;
    double maximum = 0;
    if (!finite_number(attribute(bar, kAXValueAttribute), &value) || !finite_number(attribute(bar, kAXMinValueAttribute), &minimum)
        || !finite_number(attribute(bar, kAXMaxValueAttribute), &maximum) || maximum <= minimum || !settable(bar, kAXValueAttribute)) {
        return failure(@"The app does not expose a writable scrollbar. No mouse or global-input fallback was used.");
    }
    double next = MAX(minimum, MIN(maximum, value + (increasing ? 1 : -1) * (maximum - minimum) * [request[@"amount"] doubleValue] / 10));
    NSDictionary *cursor = [self cursorForElement:element];
    if (![self validApplication] || ![self allowedElement:bar] || !within_deadline()) return failure(@"The approved app or scrollbar changed. Get app state again.");
    AXUIElementSetMessagingTimeout(bar, 1.0);
    [self showCursor:cursor element:element];
    return mutation_result(AXUIElementSetAttributeValue(bar, kAXValueAttribute, (__bridge CFNumberRef)@(next)));
}

- (NSDictionary *)handle:(NSDictionary *)request {
    _cursor = nil;
    _cursor_element = nil;
    NSDictionary *result = [self performRequest:request];
    if (_cursor && (![self validApplication]
        || !matching_cursor(_cursor, [self cursorForElement:(__bridge AXUIElementRef)_cursor_element]))) {
        write_result(@{@"event": @"cursor-invalidated"});
    }
    _cursor = nil;
    _cursor_element = nil;
    return result;
}

- (NSDictionary *)performRequest:(NSDictionary *)request {
    operation_deadline = [NSDate timeIntervalSinceReferenceDate] + 5;
    if (!validate_action(request)) return failure(@"Invalid app action or unsupported fields.");
    if (![self validApplication]) return failure(@"The approved app has closed or changed. Open it and request approval again.");
    if (!AXIsProcessTrusted()) return failure(@"Accessibility permission is required. Enable Emma in System Settings > Privacy & Security > Accessibility, then relaunch Emma.");
    if ([request[@"action"] isEqualToString:@"get_app_state"]) return [self state];
    NSString *snapshot = _snapshot;
    _snapshot = nil;
    NSUInteger index = [request[@"element_index"] unsignedIntegerValue];
    if (![snapshot isEqualToString:request[@"snapshot"]] || [NSDate timeIntervalSinceReferenceDate] - _snapshot_at > 60 || index >= _elements.count) {
        return failure(@"The app snapshot is stale or already used. Get app state again before acting.");
    }
    AXUIElementRef element = (__bridge AXUIElementRef)_elements[index];
    if (![self allowedElement:element] || ![element_identity(element) isEqualToDictionary:_identities[index]]) return failure(@"The selected control changed or is protected. Get app state again.");
    if ([attribute(element, kAXEnabledAttribute) isEqual:@NO]) return failure(@"The selected control is disabled.");
    NSString *action = request[@"action"];
    if ([action isEqualToString:@"set_value"]) return [self setValue:request[@"value"] element:element expected:nil];
    if ([action isEqualToString:@"type_text"]) {
        NSString *role = string_attribute(element, kAXRoleAttribute);
        if (![role isEqualToString:(__bridge NSString *)kAXTextFieldRole] && ![role isEqualToString:(__bridge NSString *)kAXComboBoxRole]) {
            return failure(@"Background text insertion is limited to plain text fields and combo boxes. It cannot safely preserve rich-text formatting. Use set_value only when replacing the entire value is intended.");
        }
        NSString *value = string_attribute(element, kAXValueAttribute);
        id range_value = attribute(element, kAXSelectedTextRangeAttribute);
        CFRange range = CFRangeMake(0, 0);
        if (!value || !range_value || CFGetTypeID((__bridge CFTypeRef)range_value) != AXValueGetTypeID()
            || AXValueGetType((__bridge AXValueRef)range_value) != kAXValueCFRangeType
            || !AXValueGetValue((__bridge AXValueRef)range_value, kAXValueCFRangeType, &range)) return failure(@"This control does not expose an editable text selection. Use set_value to replace its text when supported.");
        NSString *updated = inserting_text(value, range, request[@"text"]);
        if (!updated) return failure(@"The text selection is invalid or the resulting value would exceed 65,536 characters.");
        NSDictionary *result = [self setValue:updated element:element expected:value];
        if ([result[@"ok"] isEqual:@YES] && settable(element, kAXSelectedTextRangeAttribute) && [self validApplication] && [self allowedElement:element]) {
            CFRange caret = CFRangeMake(range.location + (CFIndex)[request[@"text"] length], 0);
            AXValueRef caret_value = AXValueCreate(kAXValueCFRangeType, &caret);
            if (caret_value && within_deadline()) {
                AXError caret_error = AXUIElementSetAttributeValue(element, kAXSelectedTextRangeAttribute, caret_value);
                CFRelease(caret_value);
                if (caret_error != kAXErrorSuccess) return @{@"ok": @YES, @"text": @"Text insertion was verified, but the app did not confirm the caret position. Get app state again; do not retype the text."};
            } else if (caret_value) CFRelease(caret_value);
        }
        return result;
    }
    if ([action isEqualToString:@"scroll"]) return [self scroll:request element:element];
    if ([action isEqualToString:@"click"]) {
        if (![action_names(element) containsObject:(__bridge NSString *)kAXPressAction]) return failure(@"This control does not expose a background press action. No mouse fallback was used.");
        NSDictionary *cursor = [self cursorForElement:element];
        if (![self validApplication] || ![self allowedElement:element] || !within_deadline()) return failure(@"The approved app or control changed. Get app state again.");
        AXUIElementSetMessagingTimeout(element, 1.0);
        [self showCursor:cursor element:element];
        return mutation_result(AXUIElementPerformAction(element, kAXPressAction));
    }
    NSDictionary *cursor = [self cursorForElement:element];
    id focused = attribute(_root, kAXFocusedUIElementAttribute);
    if (!focused || CFGetTypeID((__bridge CFTypeRef)focused) != AXUIElementGetTypeID()
        || !CFEqual((__bridge CFTypeRef)focused, element)) return failure(@"Key input requires the app's already-focused control. Emma will not activate or focus the app.");
    CGKeyCode key = 0;
    if (!named_key(request[@"key"], &key) || ![self validApplication] || ![self allowedElement:element] || !within_deadline()) return failure(@"The approved app or focused control changed. Get app state again.");
    CGEventSourceRef source = CGEventSourceCreate(kCGEventSourceStatePrivate);
    CGEventRef down = source ? CGEventCreateKeyboardEvent(source, key, true) : NULL;
    CGEventRef up = source ? CGEventCreateKeyboardEvent(source, key, false) : NULL;
    BOOL posted = NO;
    if (down && up && within_deadline() && [self validApplication] && within_deadline()) {
        CGEventSetFlags(down, 0);
        CGEventSetFlags(up, 0);
        [self showCursor:cursor element:element];
        CGEventPostToPid([_identity[@"pid"] intValue], down);
        CGEventPostToPid([_identity[@"pid"] intValue], up);
        posted = YES;
    }
    if (down) CFRelease(down);
    if (up) CFRelease(up);
    if (source) CFRelease(source);
    return posted ? @{@"ok": @YES, @"text": @"The key was dispatched only to the approved app. Delivery and handling are not confirmed; get app state before another action."}
        : failure(@"The key event could not be created or app control was stopped. No input was sent.");
}
@end

static void self_test(void) {
    double number = 0;
    CGRect window_bounds = CGRectMake(-100, 20, 200, 100);
    CGRect display_bounds = CGRectMake(0, 0, 1440, 900);
    assert(valid_bounds(window_bounds));
    assert(!valid_bounds(CGRectMake(NAN, 0, 100, 100)));
    assert(!valid_bounds(CGRectMake(0, 0, INFINITY, 100)));
    assert(!valid_bounds(CGRectMake(0, 0, 0, 100)));
    assert(!valid_bounds(CGRectMake(0, 0, 16385, 100)));
    assert(!valid_bounds(CGRectMake(100000, 0, 1, 1)));
    CGRect clipped = clipped_control(CGRectMake(-20, 80, 200, 80), window_bounds, display_bounds);
    assert(CGRectEqualToRect(clipped, CGRectMake(0, 80, 100, 40)));
    assert(CGRectGetMidX(clipped) == 50 && CGRectGetMidY(clipped) == 100);
    assert(CGRectIsNull(clipped_control(CGRectMake(200, 80, 20, 20), window_bounds, display_bounds)));
    assert(CGRectIsNull(clipped_control(CGRectMake(-90, 40, 20, 20), window_bounds, display_bounds)));
    assert(matching_bounds(window_bounds, CGRectMake(-99.5, 20, 200, 100)));
    assert(!matching_bounds(window_bounds, CGRectMake(-99, 20, 200, 100)));
    NSDictionary *window_frame = CFBridgingRelease(CGRectCreateDictionaryRepresentation(window_bounds));
    NSDictionary *window_info = @{(__bridge NSString *)kCGWindowOwnerPID: @42, (__bridge NSString *)kCGWindowNumber: @73,
        (__bridge NSString *)kCGWindowIsOnscreen: @YES, (__bridge NSString *)kCGWindowAlpha: @1,
        (__bridge NSString *)kCGWindowBounds: window_frame};
    assert([matching_window(@[window_info], 42, window_bounds) isEqualToDictionary:window_info]);
    assert(!matching_window(@[window_info], 43, window_bounds));
    assert(!matching_window(@[window_info, window_info], 42, window_bounds));
    NSMutableDictionary *invisible_window = [window_info mutableCopy];
    invisible_window[(__bridge NSString *)kCGWindowIsOnscreen] = @NO;
    assert(!matching_window(@[invisible_window], 42, window_bounds));
    assert(!matching_window(@[window_info, invisible_window], 42, window_bounds));
    invisible_window[(__bridge NSString *)kCGWindowIsOnscreen] = @YES;
    invisible_window[(__bridge NSString *)kCGWindowAlpha] = @0;
    assert(!matching_window(@[invisible_window], 42, window_bounds));
    NSDictionary *cursor = @{@"windowId": @73, @"bounds": @{@"x": @(-100), @"y": @20, @"width": @200, @"height": @100}, @"x": @0, @"y": @50};
    assert(matching_cursor(cursor, [cursor copy]));
    assert(!matching_cursor(cursor, nil));
    assert(!matching_cursor(nil, cursor));
    NSMutableDictionary *changed_cursor = [cursor mutableCopy];
    changed_cursor[@"windowId"] = @74;
    assert(!matching_cursor(cursor, changed_cursor));
    changed_cursor[@"windowId"] = @73;
    changed_cursor[@"x"] = @1;
    assert(!matching_cursor(cursor, changed_cursor));
    changed_cursor[@"x"] = @0;
    changed_cursor[@"bounds"] = @{@"x": @(-99), @"y": @20, @"width": @200, @"height": @100};
    assert(!matching_cursor(cursor, changed_cursor));
    assert(!allowed_role(nil));
    assert(!allowed_role(@""));
    assert(!allowed_role((__bridge NSString *)kAXMenuBarRole));
    assert(allowed_role((__bridge NSString *)kAXMenuRole));
    assert(allowed_role((__bridge NSString *)kAXMenuItemRole));
    assert(allowed_role((__bridge NSString *)kAXPopUpButtonRole));
    assert(allowed_role((__bridge NSString *)kAXWindowRole));
    assert(allowed_role((__bridge NSString *)kAXTextFieldRole));
    assert(allowed_role((__bridge NSString *)kAXButtonRole));
    assert(!finite_number(@YES, &number));
    assert(!finite_number(@(NAN), &number));
    assert(!integer_in_range(@1.5, 1, 10));
    assert(validate_action(@{@"action": @"get_app_state"}));
    assert(!validate_action(@{@"action": @"get_app_state", @"pid": @42}));
    assert(validate_action(@{@"action": @"click", @"snapshot": @"snapshot", @"element_index": @0}));
    assert(!validate_action(@{@"action": @"click", @"snapshot": @"snapshot", @"element_index": @YES}));
    assert(!validate_action(@{@"action": @"click", @"snapshot": @"snapshot", @"element_index": @400}));
    assert(!validate_action(@{@"action": @"click", @"snapshot": @"snapshot", @"element_index": @1, @"pid": @42}));
    assert(validate_action(@{@"action": @"set_value", @"snapshot": @"snapshot", @"element_index": @1, @"value": @""}));
    assert(validate_action(@{@"action": @"set_value", @"snapshot": @"snapshot", @"element_index": @1, @"value": @"first\nsecond\tthird"}));
    assert(!validate_action(@{@"action": @"type_text", @"snapshot": @"snapshot", @"element_index": @1, @"text": @""}));
    assert(validate_action(@{@"action": @"key", @"snapshot": @"snapshot", @"element_index": @1, @"key": @"Return"}));
    assert(!validate_action(@{@"action": @"key", @"snapshot": @"snapshot", @"element_index": @1, @"key": @"cmd+tab"}));
    assert(!validate_action(@{@"action": @"key", @"snapshot": @"snapshot", @"element_index": @1, @"key": @"\n"}));
    assert(validate_action(@{@"action": @"scroll", @"snapshot": @"snapshot", @"element_index": @1, @"direction": @"down", @"amount": @10}));
    assert(!validate_action(@{@"action": @"scroll", @"snapshot": @"snapshot", @"element_index": @1, @"direction": @"down", @"amount": @11}));
    assert([inserting_text(@"abcd", CFRangeMake(1, 2), @"😀") isEqualToString:@"a😀d"]);
    assert([inserting_text(@"abcd", CFRangeMake(4, 0), @"e") isEqualToString:@"abcde"]);
    assert([inserting_text(@"a😀b", CFRangeMake(1, 2), @"x") isEqualToString:@"axb"]);
    assert(!inserting_text(@"a😀b", CFRangeMake(2, 0), @"x"));
    assert(!inserting_text(@"abcd", CFRangeMake(-1, 1), @"e"));
    assert(!inserting_text(@"abcd", CFRangeMake(1, LONG_MAX), @"e"));
    NSDictionary *identity = @{@"id": @"com.example.test", @"name": @"Test", @"pid": @INT_MAX, @"path": @"/Applications/Test.app", @"launchedAt": @1};
    assert(valid_identity(identity, 0));
    assert(!valid_identity(identity, INT_MAX));
    uint64_t birth = process_birth(getpid());
    assert(birth > 0 && birth == process_birth(getpid()));
    NSMutableDictionary *direct_launch = [identity mutableCopy];
    direct_launch[@"launchedAt"] = @(birth / 1000.0);
    assert(valid_identity(direct_launch, 0));
    direct_launch[@"launchedAt"] = @0;
    assert(!valid_identity(direct_launch, 0));
    NSMutableDictionary *invalid = [identity mutableCopy];
    invalid[@"pid"] = @YES;
    assert(!valid_identity(invalid, 0));
    invalid[@"pid"] = @INT_MAX;
    invalid[@"path"] = @"Test.app";
    assert(!valid_identity(invalid, 0));
    assert(![mutation_result(kAXErrorCannotComplete)[@"ok"] boolValue]);
    assert(emma_owned(@"/Applications/Emma.app", 7, getpid()));
    assert(emma_owned(@"/Applications/Emma.app/Contents/MacOS/emma-cli", 7, 1));
    assert(emma_owned(@"/Applications/Notes.app", getpid(), 1));
    assert(!emma_owned(@"/Applications/Notes.app", 7, 1));
    assert(resolvable_app_name(@"Google Chrome"));
    assert(!resolvable_app_name(@"/Applications/Notes.app"));
    assert(!resolvable_app_name(@""));
    write_result(@{@"ok": @YES, @"text": @"App control self-test passed."});
}

int main(int argc, const char *argv[]) {
    @autoreleasepool {
        struct sigaction handler = {0};
        handler.sa_handler = cancel_input;
        sigaction(SIGTERM, &handler, NULL);
        sigaction(SIGINT, &handler, NULL);
        if (argc == 2 && strcmp(argv[1], "--self-test") == 0) {
            self_test();
            return 0;
        }
        pid_t blocked_pid = getppid();
        if ((argc == 4 || argc == 5) && strcmp(argv[argc - 2], "--blocked-pid") == 0) {
            char *end = NULL;
            long value = strtol(argv[argc - 1], &end, 10);
            if (!end || *end || value <= 0 || value > INT_MAX) {
                write_result(failure(@"Invalid blocked process identity."));
                return 1;
            }
            blocked_pid = (pid_t)value;
        }
        if ((argc == 2 || (argc == 4 && strcmp(argv[2], "--blocked-pid") == 0)) && strcmp(argv[1], "--list") == 0) {
            write_result(list_applications(blocked_pid));
            return 0;
        }
        BOOL resolving = argc == 3 && strcmp(argv[1], "--resolve") == 0;
        BOOL launching = argc == 3 && strcmp(argv[1], "--launch") == 0;
        if ((resolving || launching) && strlen(argv[2]) <= 512) {
            NSURL *url = installed_application_url(@(argv[2]));
            if (!url) {
                write_result(failure(@"No installed app matches that name. Ask the user which app to open."));
                return 1;
            }
            NSDictionary *target = launch_target(url);
            if (emma_binary_name(target[@"target"]) || [target[@"name"] caseInsensitiveCompare:@"Emma"] == NSOrderedSame) {
                write_result(failure(@"Emma cannot start itself."));
                return 1;
            }
            if (resolving) {
                write_result(@{@"ok": @YES, @"app": target});
                return 0;
            }
            NSDictionary *identity = application_identity(open_application(url));
            if (!identity) {
                write_result(failure(@"That app was started but no window appeared. Ask the user to check it."));
                return 1;
            }
            write_result(@{@"ok": @YES, @"app": identity, @"target": target});
            return 0;
        }
        if (argc != 5 || strcmp(argv[1], "--app") != 0 || strcmp(argv[3], "--blocked-pid") != 0 || strlen(argv[2]) > 16384) {
            write_result(failure(@"Expected --list, --resolve, --launch, or --app with an approved identity and --blocked-pid."));
            return 1;
        }
        NSData *identity_data = [NSData dataWithBytes:argv[2] length:strlen(argv[2])];
        id identity = [NSJSONSerialization JSONObjectWithData:identity_data options:0 error:NULL];
        AppSession *session = [[AppSession alloc] initWithIdentity:identity blockedPID:blocked_pid];
        if (!session) {
            write_result(failure(@"The approved app is no longer running with the same identity. Open it and request approval again."));
            return 1;
        }
        char *line = malloc(max_input_bytes + 2);
        if (!line) return 1;
        while (!cancelled && fgets(line, (int)max_input_bytes + 2, stdin)) {
            size_t length = strlen(line);
            if (!length || line[length - 1] != '\n' || length > max_input_bytes) {
                write_result(failure(@"App action exceeds the input limit or contains an invalid byte."));
                break;
            }
            @autoreleasepool {
                NSData *data = [NSData dataWithBytes:line length:length - 1];
                id request = [NSJSONSerialization JSONObjectWithData:data options:0 error:NULL];
                write_result([session handle:request]);
            }
        }
        free(line);
        return 0;
    }
}
