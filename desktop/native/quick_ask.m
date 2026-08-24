#import <AppKit/AppKit.h>
#import <ApplicationServices/ApplicationServices.h>
#include <assert.h>
#include <math.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

typedef enum { TapDown, TapUp, TapCancel } TapEvent;
static const uint16_t kLeftOptionKeyCode = 58;
typedef struct {
    bool is_down;
    bool has_previous_release;
    bool ignore_release;
    NSTimeInterval previous_release;
} DoubleLeftOption;

static bool handle_tap(DoubleLeftOption *tap, TapEvent event, NSTimeInterval time) {
    switch (event) {
        case TapCancel:
            memset(tap, 0, sizeof(*tap));
            break;
        case TapDown:
            if (tap->is_down) return false;
            tap->is_down = true;
            if (tap->has_previous_release && time >= tap->previous_release && time - tap->previous_release <= 0.35) {
                tap->has_previous_release = false;
                tap->ignore_release = true;
                return true;
            }
            break;
        case TapUp:
            if (!tap->is_down) return false;
            tap->is_down = false;
            if (tap->ignore_release) {
                tap->ignore_release = false;
                tap->has_previous_release = false;
            } else {
                tap->has_previous_release = true;
                tap->previous_release = time;
            }
            break;
    }
    return false;
}

/* A modifier held down on its own, which macOS itself does nothing with. Only the
   listener can see this: a global shortcut is only ever told about the key going down.
   Anything else happening — a second modifier, a keystroke, the release — cancels the
   hold, so holding Shift to type a long capitalised word never opens Emma. */
#define kMaxHolds 8
typedef struct {
    uint16_t key_code;
    double seconds;
    char id[32];
} HoldBinding;

typedef struct {
    HoldBinding items[kMaxHolds];
    size_t count;
} HoldSet;

typedef struct {
    HoldSet set;
    size_t armed;
    uint64_t generation;
} HoldWatch;

static const CGEventFlags kModifierMask = kCGEventFlagMaskAlphaShift | kCGEventFlagMaskShift
    | kCGEventFlagMaskControl | kCGEventFlagMaskAlternate | kCGEventFlagMaskCommand
    | kCGEventFlagMaskNumericPad | kCGEventFlagMaskHelp | kCGEventFlagMaskSecondaryFn;

static const struct { uint16_t code; CGEventFlags flag; } kModifierFlags[] = {
    {54, kCGEventFlagMaskCommand}, {55, kCGEventFlagMaskCommand},
    {56, kCGEventFlagMaskShift}, {60, kCGEventFlagMaskShift},
    {58, kCGEventFlagMaskAlternate}, {61, kCGEventFlagMaskAlternate},
    {59, kCGEventFlagMaskControl}, {62, kCGEventFlagMaskControl},
};

static CGEventFlags modifier_flag(uint16_t key_code) {
    for (size_t index = 0; index < sizeof(kModifierFlags) / sizeof(kModifierFlags[0]); index += 1) {
        if (kModifierFlags[index].code == key_code) return kModifierFlags[index].flag;
    }
    return 0;
}

static size_t handle_hold(HoldWatch *watch, CGEventType type, uint16_t key_code, CGEventFlags flags) {
    flags &= kModifierMask;
    if (type != kCGEventFlagsChanged) { watch->armed = 0; watch->generation += 1; return 0; }
    for (size_t index = 0; index < watch->set.count; index += 1) {
        CGEventFlags flag = modifier_flag(watch->set.items[index].key_code);
        if (watch->set.items[index].key_code == key_code && flag != 0 && flags == flag) {
            watch->armed = index + 1;
            watch->generation += 1;
            return watch->armed;
        }
    }
    watch->armed = 0;
    watch->generation += 1;
    return 0;
}

/** True when the armed hold is still the one that armed at this generation and time. */
static bool hold_survived(const HoldWatch *watch, size_t armed, uint64_t generation) {
    return watch->armed == armed && armed != 0 && watch->generation == generation;
}

static HoldSet parse_holds(NSDictionary *object) {
    HoldSet set = {0};
    HoldBinding *out = set.items;
    NSArray *items = [object isKindOfClass:[NSDictionary class]] ? object[@"holds"] : nil;
    if (![items isKindOfClass:[NSArray class]]) return set;
    size_t count = 0;
    for (NSDictionary *item in items) {
        if (count == kMaxHolds || ![item isKindOfClass:[NSDictionary class]]) break;
        id identifier = item[@"id"];
        id key_code = item[@"keyCode"];
        id ms = item[@"ms"];
        if (![identifier isKindOfClass:[NSString class]] || ![key_code isKindOfClass:[NSNumber class]] || ![ms isKindOfClass:[NSNumber class]]) continue;
        double milliseconds = [ms doubleValue];
        int code = [key_code intValue];
        if (milliseconds < 100 || milliseconds > 5000 || code < 0 || code > 0xFFFF || modifier_flag((uint16_t)code) == 0) continue;
        const char *name = [(NSString *)identifier UTF8String];
        if (!name || strlen(name) >= sizeof(out[0].id)) continue;
        out[count].key_code = (uint16_t)code;
        out[count].seconds = milliseconds / 1000.0;
        strncpy(out[count].id, name, sizeof(out[0].id) - 1);
        out[count].id[sizeof(out[0].id) - 1] = '\0';
        count += 1;
    }
    set.count = count;
    return set;
}

static TapEvent event_input(CGEventType type, uint16_t key_code, CGEventFlags flags) {
    if (type != kCGEventFlagsChanged || key_code != kLeftOptionKeyCode) return TapCancel;

    flags &= kModifierMask;
    if (flags == kCGEventFlagMaskAlternate) return TapDown;
    if (flags == 0) return TapUp;
    return TapCancel;
}

// Reports the real camera-housing bounds per display. AppKit exposes the unobscured
// areas beside the housing; the notch is what sits between them.
static int print_screens(void) {
    NSMutableArray *items = [NSMutableArray array];
    for (NSScreen *screen in [NSScreen screens]) {
        NSNumber *number = screen.deviceDescription[@"NSScreenNumber"];
        if (![number isKindOfClass:[NSNumber class]]) continue;
        NSRect left = screen.auxiliaryTopLeftArea;
        NSRect right = screen.auxiliaryTopRightArea;
        CGFloat height = screen.safeAreaInsets.top;
        CGFloat notch_left = NSMaxX(left);
        CGFloat notch_width = NSMinX(right) - notch_left;
        if (height <= 0 || NSWidth(left) <= 0 || NSWidth(right) <= 0 || notch_width <= 0) continue;
        [items addObject:@{@"id": number, @"x": @(notch_left), @"width": @(notch_width), @"height": @(height)}];
    }
    NSData *json = [NSJSONSerialization dataWithJSONObject:items options:0 error:NULL];
    if (!json) {
        fputs("Emma: unable to serialize display geometry.\n", stderr);
        return 1;
    }
    fwrite(json.bytes, 1, json.length, stdout);
    fputc('\n', stdout);
    fflush(stdout);
    return 0;
}

static NSString *attribute_string(AXUIElementRef element, CFStringRef attribute) {
    if (!element) return nil;
    CFTypeRef value = NULL;
    if (AXUIElementCopyAttributeValue(element, attribute, &value) != kAXErrorSuccess || !value) return nil;
    if (CFGetTypeID(value) != CFStringGetTypeID()) {
        CFRelease(value);
        return nil;
    }
    return (__bridge_transfer NSString *)value;
}

static NSString *accessibility_selection(pid_t pid, NSString **window_title) {
    AXUIElementRef application = AXUIElementCreateApplication(pid);
    if (!application) return nil;
    NSString *selected = nil;
    CFTypeRef focused = NULL;
    if (AXUIElementCopyAttributeValue(application, kAXFocusedUIElementAttribute, &focused) == kAXErrorSuccess && focused) {
        selected = attribute_string((AXUIElementRef)focused, kAXSelectedTextAttribute);
        CFRelease(focused);
    }
    CFTypeRef window = NULL;
    if (AXUIElementCopyAttributeValue(application, kAXFocusedWindowAttribute, &window) == kAXErrorSuccess && window) {
        *window_title = attribute_string((AXUIElementRef)window, kAXTitleAttribute);
        CFRelease(window);
    }
    CFRelease(application);
    return selected;
}

static NSString *copied_selection(void) {
    NSPasteboard *board = [NSPasteboard generalPasteboard];
    NSInteger before = board.changeCount;
    NSString *held = [board stringForType:NSPasteboardTypeString];

    CGEventSourceRef source = CGEventSourceCreate(kCGEventSourceStateHIDSystemState);
    CGEventRef down = CGEventCreateKeyboardEvent(source, (CGKeyCode)8, true);
    CGEventRef up = CGEventCreateKeyboardEvent(source, (CGKeyCode)8, false);
    if (!down || !up) {
        if (down) CFRelease(down);
        if (up) CFRelease(up);
        if (source) CFRelease(source);
        return nil;
    }
    CGEventSetFlags(down, kCGEventFlagMaskCommand);
    CGEventSetFlags(up, kCGEventFlagMaskCommand);
    CGEventPost(kCGHIDEventTap, down);
    CGEventPost(kCGHIDEventTap, up);
    CFRelease(down);
    CFRelease(up);
    if (source) CFRelease(source);

    NSString *copied = nil;
    for (int attempt = 0; attempt < 40; attempt += 1) {
        [NSThread sleepForTimeInterval:0.01];
        if (board.changeCount == before) continue;
        copied = [board stringForType:NSPasteboardTypeString];
        break;
    }
    if (copied && held) {
        [board clearContents];
        [board setString:held forType:NSPasteboardTypeString];
    }
    return copied;
}

static int print_selection(void) {
    NSMutableDictionary *item = [NSMutableDictionary dictionary];
    if (!AXIsProcessTrusted()) {
        item[@"error"] = @"accessibility";
    } else {
        NSRunningApplication *front = [NSWorkspace sharedWorkspace].frontmostApplication;
        NSString *window = nil;
        NSString *text = front ? accessibility_selection(front.processIdentifier, &window) : nil;
        if (!text.length) text = copied_selection();
        if (text.length) item[@"text"] = text;
        if (front.localizedName.length) item[@"application"] = front.localizedName;
        if (window.length) item[@"window"] = window;
    }
    NSData *json = [NSJSONSerialization dataWithJSONObject:item options:0 error:NULL];
    if (!json) {
        fputs("Emma: unable to serialize the selection.\n", stderr);
        return 1;
    }
    fwrite(json.bytes, 1, json.length, stdout);
    fputc('\n', stdout);
    fflush(stdout);
    return 0;
}

// Bounded computer-use input. One JSON action per stdin line, one JSON result per line.
// Emma's Electron main process owns the permission gate; this helper only validates and posts.
#define kMaxInputLine (64 * 1024)
#define kMaxTypedCharacters 4096

// The longest a single hold_key may pin a key down, in seconds. The tool's own
// ceiling is 300; this is the backstop for a helper driven by anything else.
#define kMaxHoldSeconds 300.0

typedef enum {
    ActionInvalid, ActionMove, ActionClick, ActionScroll, ActionType, ActionKey,
    ActionMouseDown, ActionMouseUp, ActionDrag, ActionHoldKey,
} ActionKind;

typedef struct {
    ActionKind kind;
    CGPoint point;
    /** Where a drag starts. `point` is where it ends. */
    CGPoint origin;
    int clicks;
    CGMouseButton button;
    int scroll_x;
    int scroll_y;
    CGKeyCode key_code;
    CGEventFlags flags;
    double seconds;
    /** False for the actions that happen wherever the pointer already is. */
    bool has_point;
} InputAction;

/* Names as the computer-use tool spells them: X11 keysyms, which is what the
   model emits, lowercased before lookup. The aliases are the ones that actually
   turn up — `return` and `Return`, `esc` and `Escape`, `prior` and `Page_Up`. */
static const struct { const char *name; CGKeyCode code; } kNamedKeys[] = {
    {"a", 0}, {"b", 11}, {"c", 8}, {"d", 2}, {"e", 14}, {"f", 3}, {"g", 5},
    {"h", 4}, {"i", 34}, {"j", 38}, {"k", 40}, {"l", 37}, {"m", 46}, {"n", 45},
    {"o", 31}, {"p", 35}, {"q", 12}, {"r", 15}, {"s", 1}, {"t", 17}, {"u", 32},
    {"v", 9}, {"w", 13}, {"x", 7}, {"y", 16}, {"z", 6},
    {"0", 29}, {"1", 18}, {"2", 19}, {"3", 20}, {"4", 21},
    {"5", 23}, {"6", 22}, {"7", 26}, {"8", 28}, {"9", 25},
    {"f1", 122}, {"f2", 120}, {"f3", 99}, {"f4", 118}, {"f5", 96}, {"f6", 97},
    {"f7", 98}, {"f8", 100}, {"f9", 101}, {"f10", 109}, {"f11", 103}, {"f12", 111},
    {"return", 36}, {"enter", 36}, {"kp_enter", 76}, {"tab", 48}, {"space", 49},
    {"backspace", 51}, {"delete", 51}, {"forward_delete", 117},
    {"escape", 53}, {"esc", 53},
    {"left", 123}, {"right", 124}, {"down", 125}, {"up", 126},
    {"home", 115}, {"end", 119},
    {"page_up", 116}, {"pageup", 116}, {"prior", 116},
    {"page_down", 121}, {"pagedown", 121}, {"next", 121},
    {"minus", 27}, {"equal", 24}, {"bracketleft", 33}, {"bracketright", 30},
    {"backslash", 42}, {"semicolon", 41}, {"apostrophe", 39}, {"grave", 50},
    {"comma", 43}, {"period", 47}, {"slash", 44},
    // The modifiers themselves, because `hold_key` is mostly used to hold one.
    {"shift", 56}, {"shift_l", 56}, {"control", 59}, {"ctrl", 59}, {"control_l", 59},
    {"alt", 58}, {"option", 58}, {"alt_l", 58}, {"super", 55}, {"command", 55}, {"super_l", 55},
};

static bool named_key(NSString *name, CGKeyCode *code) {
    const char *value = name.lowercaseString.UTF8String;
    if (!value) return false;
    for (size_t index = 0; index < sizeof(kNamedKeys) / sizeof(kNamedKeys[0]); index += 1) {
        if (strcmp(kNamedKeys[index].name, value) == 0) {
            *code = kNamedKeys[index].code;
            return true;
        }
    }
    return false;
}

static bool modifier_flags(NSArray *modifiers, CGEventFlags *flags) {
    *flags = 0;
    if (!modifiers) return true;
    if (![modifiers isKindOfClass:[NSArray class]] || modifiers.count > 4) return false;
    for (id item in modifiers) {
        if (![item isKindOfClass:[NSString class]]) return false;
        NSString *name = [(NSString *)item lowercaseString];
        // Both spellings: Emma's own callers say "command", the computer-use
        // vocabulary the model already knows says the X11 "super"/"alt"/"ctrl".
        if ([name isEqualToString:@"command"] || [name isEqualToString:@"super"] || [name isEqualToString:@"cmd"]) *flags |= kCGEventFlagMaskCommand;
        else if ([name isEqualToString:@"shift"]) *flags |= kCGEventFlagMaskShift;
        else if ([name isEqualToString:@"option"] || [name isEqualToString:@"alt"]) *flags |= kCGEventFlagMaskAlternate;
        else if ([name isEqualToString:@"control"] || [name isEqualToString:@"ctrl"]) *flags |= kCGEventFlagMaskControl;
        else return false;
    }
    return true;
}

static bool number_value(id value, double *out) {
    if (![value isKindOfClass:[NSNumber class]]) return false;
    double number = [(NSNumber *)value doubleValue];
    if (!isfinite(number)) return false;
    *out = number;
    return true;
}

/** Reads an optional bounded seconds value, for the two actions that wait. */
static bool duration_value(id value, double *out, NSString **error) {
    double seconds = 0;
    if (value && !number_value(value, &seconds)) { *error = @"duration is invalid"; return false; }
    if (seconds < 0 || seconds > kMaxHoldSeconds) { *error = @"duration is out of range"; return false; }
    *out = seconds;
    return true;
}

// Parses one action. Never posts an event, so the self-test can exercise it directly.
static bool parse_action(NSDictionary *object, InputAction *action, NSString **text, NSString **error) {
    *text = nil;
    memset(action, 0, sizeof(*action));
    if (![object isKindOfClass:[NSDictionary class]]) { *error = @"action must be an object"; return false; }
    id kind = object[@"action"];
    if (![kind isKindOfClass:[NSString class]]) { *error = @"action name is invalid"; return false; }

    double x = 0;
    double y = 0;
    bool has_point = number_value(object[@"x"], &x) && number_value(object[@"y"], &y);
    if (has_point && (fabs(x) > 100000 || fabs(y) > 100000)) { *error = @"action coordinates are out of range"; return false; }
    action->point = CGPointMake(x, y);
    action->has_point = has_point;
    if (!modifier_flags(object[@"modifiers"], &action->flags)) { *error = @"key modifiers are invalid"; return false; }

    if ([kind isEqualToString:@"move"] || [kind isEqualToString:@"click"] || [kind isEqualToString:@"double_click"]
        || [kind isEqualToString:@"triple_click"] || [kind isEqualToString:@"mouse_down"] || [kind isEqualToString:@"mouse_up"]) {
        // Down and up happen wherever the pointer already is: that is the whole
        // point of splitting them out of `click`, so they take no coordinates.
        bool held = [kind isEqualToString:@"mouse_down"] || [kind isEqualToString:@"mouse_up"];
        if (!has_point && !held) { *error = @"action requires numeric x and y"; return false; }
        if ([kind isEqualToString:@"move"]) { action->kind = ActionMove; return true; }
        id button = object[@"button"];
        if (button && ![button isKindOfClass:[NSString class]]) { *error = @"click button is invalid"; return false; }
        if (!button || [button isEqualToString:@"left"]) action->button = kCGMouseButtonLeft;
        else if ([button isEqualToString:@"right"]) action->button = kCGMouseButtonRight;
        else if ([button isEqualToString:@"middle"]) action->button = kCGMouseButtonCenter;
        else { *error = @"click button is invalid"; return false; }
        if (held) { action->kind = [kind isEqualToString:@"mouse_down"] ? ActionMouseDown : ActionMouseUp; return true; }
        action->kind = ActionClick;
        double clicks = 1;
        if (object[@"clicks"] && !number_value(object[@"clicks"], &clicks)) { *error = @"click count is invalid"; return false; }
        if ([kind isEqualToString:@"double_click"]) clicks = 2;
        if ([kind isEqualToString:@"triple_click"]) clicks = 3;
        if (clicks < 1 || clicks > 3) { *error = @"click count must be 1, 2 or 3"; return false; }
        action->clicks = (int)clicks;
        return true;
    }
    if ([kind isEqualToString:@"drag"]) {
        double origin_x = 0;
        double origin_y = 0;
        if (!has_point || !number_value(object[@"fromX"], &origin_x) || !number_value(object[@"fromY"], &origin_y)) {
            *error = @"drag requires numeric fromX, fromY, x and y";
            return false;
        }
        if (fabs(origin_x) > 100000 || fabs(origin_y) > 100000) { *error = @"action coordinates are out of range"; return false; }
        action->kind = ActionDrag;
        action->origin = CGPointMake(origin_x, origin_y);
        action->button = kCGMouseButtonLeft;
        return true;
    }
    if ([kind isEqualToString:@"scroll"]) {
        if (!has_point) { *error = @"action requires numeric x and y"; return false; }
        double dx = 0;
        double dy = 0;
        if (!number_value(object[@"dx"] ?: @0, &dx) || !number_value(object[@"dy"] ?: @0, &dy)) { *error = @"scroll amounts are invalid"; return false; }
        if (fabs(dx) > 50 || fabs(dy) > 50) { *error = @"scroll amount must be within 50 lines"; return false; }
        action->kind = ActionScroll;
        action->scroll_x = (int)dx;
        action->scroll_y = (int)dy;
        return true;
    }
    if ([kind isEqualToString:@"hold_key"]) {
        id value = object[@"key"];
        if (![value isKindOfClass:[NSString class]] || !named_key(value, &action->key_code)) { *error = @"key name is not supported"; return false; }
        if (!duration_value(object[@"duration"], &action->seconds, error)) return false;
        action->kind = ActionHoldKey;
        return true;
    }
    if ([kind isEqualToString:@"type"]) {
        id value = object[@"text"];
        if (![value isKindOfClass:[NSString class]] || ((NSString *)value).length == 0) { *error = @"typed text is invalid"; return false; }
        if (((NSString *)value).length > kMaxTypedCharacters) { *error = @"typed text is too long"; return false; }
        action->kind = ActionType;
        *text = value;
        return true;
    }
    if ([kind isEqualToString:@"key"]) {
        id value = object[@"key"];
        if (![value isKindOfClass:[NSString class]] || !named_key(value, &action->key_code)) { *error = @"key name is not supported"; return false; }
        if (!modifier_flags(object[@"modifiers"], &action->flags)) { *error = @"key modifiers are invalid"; return false; }
        action->kind = ActionKey;
        return true;
    }
    *error = @"action name is not supported";
    return false;
}

// CGDisplayBounds already uses the flipped global space CGEvent expects, so no AppKit conversion.
static bool point_on_active_display(CGPoint point) {
    CGDirectDisplayID displays[16];
    uint32_t count = 0;
    if (CGGetActiveDisplayList(16, displays, &count) != kCGErrorSuccess) return false;
    for (uint32_t index = 0; index < count; index += 1) {
        if (CGRectContainsPoint(CGDisplayBounds(displays[index]), point)) return true;
    }
    return false;
}

static void post(CGEventRef event) {
    if (!event) return;
    CGEventPost(kCGHIDEventTap, event);
    CFRelease(event);
}

/** Where the pointer is right now, in the same flipped global space every action uses. */
static CGPoint cursor_point(void) {
    CGEventRef probe = CGEventCreate(NULL);
    CGPoint point = probe ? CGEventGetLocation(probe) : CGPointZero;
    if (probe) CFRelease(probe);
    return point;
}

/** The down/up pair for one button, since the three buttons do not share a type. */
static CGEventType button_event(CGMouseButton button, bool down) {
    if (button == kCGMouseButtonRight) return down ? kCGEventRightMouseDown : kCGEventRightMouseUp;
    if (button == kCGMouseButtonCenter) return down ? kCGEventOtherMouseDown : kCGEventOtherMouseUp;
    return down ? kCGEventLeftMouseDown : kCGEventLeftMouseUp;
}

static CGEventType drag_event(CGMouseButton button) {
    if (button == kCGMouseButtonRight) return kCGEventRightMouseDragged;
    if (button == kCGMouseButtonCenter) return kCGEventOtherMouseDragged;
    return kCGEventLeftMouseDragged;
}

/** Posts one mouse event with the run's modifiers held, which a plain post would drop. */
static void post_mouse(CGEventType type, CGPoint point, CGMouseButton button, CGEventFlags flags, int64_t clicks) {
    CGEventRef event = CGEventCreateMouseEvent(NULL, type, point, button);
    if (!event) return;
    if (flags) CGEventSetFlags(event, flags);
    if (clicks) CGEventSetIntegerValueField(event, kCGMouseEventClickState, clicks);
    post(event);
}

static bool perform_action(InputAction action, NSString *text, NSString **error) {
    bool needs_point = action.kind != ActionType && action.kind != ActionKey && action.kind != ActionHoldKey
        && action.kind != ActionMouseDown && action.kind != ActionMouseUp;
    if (needs_point && !point_on_active_display(action.point)) {
        *error = @"action coordinates are not on an active display";
        return false;
    }
    if (action.kind == ActionDrag && !point_on_active_display(action.origin)) {
        *error = @"action coordinates are not on an active display";
        return false;
    }
    switch (action.kind) {
        case ActionMove:
            post_mouse(kCGEventMouseMoved, action.point, kCGMouseButtonLeft, action.flags, 0);
            break;
        case ActionClick: {
            post_mouse(kCGEventMouseMoved, action.point, action.button, action.flags, 0);
            for (int click = 1; click <= action.clicks; click += 1) {
                post_mouse(button_event(action.button, true), action.point, action.button, action.flags, click);
                post_mouse(button_event(action.button, false), action.point, action.button, action.flags, click);
            }
            break;
        }
        case ActionMouseDown:
        case ActionMouseUp: {
            // Wherever the pointer already is: `mouse_move` put it there, and a
            // drag built out of these is the caller's to sequence.
            CGPoint point = action.has_point ? action.point : cursor_point();
            post_mouse(button_event(action.button, action.kind == ActionMouseDown), point, action.button, action.flags, 1);
            break;
        }
        case ActionDrag: {
            // Dragged through a midpoint rather than teleported: a single jump from
            // press to release is not a gesture most views recognise as a drag.
            CGPoint middle = CGPointMake((action.origin.x + action.point.x) / 2, (action.origin.y + action.point.y) / 2);
            post_mouse(kCGEventMouseMoved, action.origin, action.button, action.flags, 0);
            post_mouse(button_event(action.button, true), action.origin, action.button, action.flags, 1);
            post_mouse(drag_event(action.button), middle, action.button, action.flags, 1);
            post_mouse(drag_event(action.button), action.point, action.button, action.flags, 1);
            post_mouse(button_event(action.button, false), action.point, action.button, action.flags, 1);
            break;
        }
        case ActionScroll: {
            post_mouse(kCGEventMouseMoved, action.point, kCGMouseButtonLeft, action.flags, 0);
            CGEventRef wheel = CGEventCreateScrollWheelEvent(NULL, kCGScrollEventUnitLine, 2, action.scroll_y, action.scroll_x);
            if (wheel && action.flags) CGEventSetFlags(wheel, action.flags);
            post(wheel);
            break;
        }
        case ActionType: {
            // Unicode strings avoid a keycode/layout table entirely.
            NSUInteger length = text.length;
            for (NSUInteger start = 0; start < length; start += 32) {
                NSRange range = NSMakeRange(start, MIN((NSUInteger)32, length - start));
                NSString *chunk = [text substringWithRange:range];
                unichar buffer[32];
                [chunk getCharacters:buffer range:NSMakeRange(0, chunk.length)];
                CGEventRef down = CGEventCreateKeyboardEvent(NULL, 0, true);
                CGEventRef up = CGEventCreateKeyboardEvent(NULL, 0, false);
                if (down) CGEventKeyboardSetUnicodeString(down, chunk.length, buffer);
                if (up) CGEventKeyboardSetUnicodeString(up, chunk.length, buffer);
                post(down);
                post(up);
            }
            break;
        }
        case ActionKey: {
            CGEventRef down = CGEventCreateKeyboardEvent(NULL, action.key_code, true);
            CGEventRef up = CGEventCreateKeyboardEvent(NULL, action.key_code, false);
            if (down) CGEventSetFlags(down, action.flags);
            if (up) CGEventSetFlags(up, action.flags);
            post(down);
            post(up);
            break;
        }
        case ActionHoldKey: {
            // Held by repeating the down event, the way the OS's own key repeat
            // reaches an app: one long press posts nothing while it is held.
            CGEventRef down = CGEventCreateKeyboardEvent(NULL, action.key_code, true);
            if (down) CGEventSetFlags(down, action.flags);
            post(down);
            NSDate *until = [NSDate dateWithTimeIntervalSinceNow:action.seconds];
            while ([until timeIntervalSinceNow] > 0) {
                [NSThread sleepForTimeInterval:0.05];
                CGEventRef again = CGEventCreateKeyboardEvent(NULL, action.key_code, true);
                if (again) {
                    CGEventSetFlags(again, action.flags);
                    CGEventSetIntegerValueField(again, kCGKeyboardEventAutorepeat, 1);
                }
                post(again);
            }
            CGEventRef up = CGEventCreateKeyboardEvent(NULL, action.key_code, false);
            if (up) CGEventSetFlags(up, action.flags);
            post(up);
            break;
        }
        case ActionInvalid:
            *error = @"action is invalid";
            return false;
    }
    return true;
}

static void write_result(bool ok, NSString *message) {
    NSDictionary *result = ok ? @{@"ok": @YES} : @{@"ok": @NO, @"error": message ?: @"action failed"};
    NSData *json = [NSJSONSerialization dataWithJSONObject:result options:0 error:NULL];
    if (json) fwrite(json.bytes, 1, json.length, stdout);
    fputc('\n', stdout);
    fflush(stdout);
}

static int run_input(void) {
    if (!AXIsProcessTrusted()) {
        fputs("Emma: Accessibility access is required to control the computer. Grant it in System Settings, then relaunch Emma.\n", stderr);
        write_result(false, @"Accessibility access is not granted");
        return 1;
    }
    char *line = malloc(kMaxInputLine);
    if (!line) return 1;
    while (fgets(line, kMaxInputLine, stdin)) {
        size_t length = strlen(line);
        if (length == 0) continue;
        if (line[length - 1] != '\n') {
            write_result(false, @"action line is too long");
            int discarded;
            while ((discarded = fgetc(stdin)) != '\n' && discarded != EOF) { }
            continue;
        }
        @autoreleasepool {
            NSData *data = [NSData dataWithBytes:line length:length - 1];
            NSDictionary *object = data.length ? [NSJSONSerialization JSONObjectWithData:data options:0 error:NULL] : nil;
            InputAction action;
            NSString *text = nil;
            NSString *error = @"action is not valid JSON";
            if (object && parse_action(object, &action, &text, &error) && perform_action(action, text, &error)) write_result(true, nil);
            else write_result(false, error);
        }
    }
    free(line);
    return 0;
}

static void self_test(void) {
    DoubleLeftOption tap = {0};
    assert(!handle_tap(&tap, TapDown, 0));
    assert(!handle_tap(&tap, TapDown, 0.01));
    assert(!handle_tap(&tap, TapUp, 0.05));
    assert(handle_tap(&tap, TapDown, 0.2));
    assert(!handle_tap(&tap, TapUp, 0.25));
    assert(!handle_tap(&tap, TapDown, 0.3));
    assert(!handle_tap(&tap, TapUp, 0.35));
    assert(handle_tap(&tap, TapDown, 0.5));

    memset(&tap, 0, sizeof(tap));
    assert(!handle_tap(&tap, TapDown, 0));
    assert(!handle_tap(&tap, TapUp, 0.05));
    assert(!handle_tap(&tap, TapDown, 0.5));
    assert(!handle_tap(&tap, TapCancel, 0.51));
    assert(!handle_tap(&tap, TapDown, 0.6));

    assert(event_input(kCGEventFlagsChanged, kLeftOptionKeyCode, kCGEventFlagMaskAlternate) == TapDown);
    assert(event_input(kCGEventFlagsChanged, kLeftOptionKeyCode, kCGEventFlagMaskAlternate | kCGEventFlagMaskNonCoalesced) == TapDown);
    assert(event_input(kCGEventFlagsChanged, kLeftOptionKeyCode, 0) == TapUp);
    assert(event_input(kCGEventFlagsChanged, 61, kCGEventFlagMaskAlternate) == TapCancel);
    assert(event_input(kCGEventFlagsChanged, kLeftOptionKeyCode, kCGEventFlagMaskAlternate | kCGEventFlagMaskCommand) == TapCancel);
    assert(event_input(kCGEventFlagsChanged, kLeftOptionKeyCode, kCGEventFlagMaskAlternate | kCGEventFlagMaskSecondaryFn) == TapCancel);
    assert(event_input(kCGEventKeyDown, 0, 0) == TapCancel);

    HoldWatch watch = {0};
    watch.set = parse_holds(@{@"holds": @[@{@"id": @"voice", @"keyCode": @58, @"ms": @500}, @{@"id": @"bad", @"keyCode": @0, @"ms": @500}]});
    // A letter key is not holdable, so only the modifier binding survives parsing.
    assert(watch.set.count == 1 && watch.set.items[0].key_code == 58 && watch.set.items[0].seconds == 0.5);
    size_t armed = handle_hold(&watch, kCGEventFlagsChanged, 58, kCGEventFlagMaskAlternate);
    assert(armed == 1);
    uint64_t generation = watch.generation;
    assert(hold_survived(&watch, armed, generation));
    // Releasing, adding a second modifier, or typing under the hold all cancel it.
    assert(handle_hold(&watch, kCGEventFlagsChanged, 58, 0) == 0);
    assert(!hold_survived(&watch, armed, generation));
    armed = handle_hold(&watch, kCGEventFlagsChanged, 58, kCGEventFlagMaskAlternate);
    generation = watch.generation;
    assert(armed == 1 && handle_hold(&watch, kCGEventFlagsChanged, 56, kCGEventFlagMaskAlternate | kCGEventFlagMaskShift) == 0);
    assert(!hold_survived(&watch, armed, generation));
    armed = handle_hold(&watch, kCGEventFlagsChanged, 58, kCGEventFlagMaskAlternate);
    generation = watch.generation;
    assert(armed == 1 && handle_hold(&watch, kCGEventKeyDown, 0, kCGEventFlagMaskAlternate) == 0);
    assert(!hold_survived(&watch, armed, generation));
    // The other Option key is a different binding, and an unbound modifier arms nothing.
    assert(handle_hold(&watch, kCGEventFlagsChanged, 61, kCGEventFlagMaskAlternate) == 0);
    assert(handle_hold(&watch, kCGEventFlagsChanged, 56, kCGEventFlagMaskShift) == 0);

    InputAction action;
    NSString *text = nil;
    NSString *error = nil;
    assert(parse_action(@{@"action": @"click", @"x": @10, @"y": @20}, &action, &text, &error));
    assert(action.kind == ActionClick && action.clicks == 1 && action.button == kCGMouseButtonLeft);
    assert(parse_action(@{@"action": @"double_click", @"x": @10, @"y": @20}, &action, &text, &error));
    assert(action.clicks == 2);
    assert(parse_action(@{@"action": @"key", @"key": @"c", @"modifiers": @[@"command"]}, &action, &text, &error));
    assert(action.kind == ActionKey && action.key_code == 8 && action.flags == kCGEventFlagMaskCommand);
    assert(parse_action(@{@"action": @"type", @"text": @"hello"}, &action, &text, &error));
    assert(action.kind == ActionType && [text isEqualToString:@"hello"]);
    assert(parse_action(@{@"action": @"scroll", @"x": @1, @"y": @2, @"dy": @-3}, &action, &text, &error));
    assert(action.kind == ActionScroll && action.scroll_y == -3 && action.scroll_x == 0);

    assert(parse_action(@{@"action": @"triple_click", @"x": @1, @"y": @2, @"button": @"middle"}, &action, &text, &error));
    assert(action.clicks == 3 && action.button == kCGMouseButtonCenter);
    assert(parse_action(@{@"action": @"mouse_down", @"button": @"right"}, &action, &text, &error));
    assert(action.kind == ActionMouseDown && !action.has_point && action.button == kCGMouseButtonRight);
    assert(parse_action(@{@"action": @"drag", @"fromX": @1, @"fromY": @2, @"x": @3, @"y": @4, @"modifiers": @[@"shift"]}, &action, &text, &error));
    assert(action.kind == ActionDrag && action.origin.x == 1 && action.point.y == 4 && action.flags == kCGEventFlagMaskShift);
    assert(parse_action(@{@"action": @"hold_key", @"key": @"shift", @"duration": @2}, &action, &text, &error));
    assert(action.kind == ActionHoldKey && action.seconds == 2);

    assert(!parse_action(@{@"action": @"drag", @"x": @3, @"y": @4}, &action, &text, &error));
    assert(!parse_action(@{@"action": @"hold_key", @"key": @"a", @"duration": @400}, &action, &text, &error));
    assert(!parse_action(@{@"action": @"hold_key", @"key": @"a", @"duration": @-1}, &action, &text, &error));
    assert(!parse_action(@{@"action": @"click", @"x": @1, @"y": @2, @"clicks": @4}, &action, &text, &error));
    assert(!parse_action(@{@"action": @"click"}, &action, &text, &error));
    assert(!parse_action(@{@"action": @"click", @"x": @"10", @"y": @20}, &action, &text, &error));
    assert(!parse_action(@{@"action": @"move", @"x": @1e9, @"y": @0}, &action, &text, &error));
    assert(!parse_action(@{@"action": @"scroll", @"x": @1, @"y": @2, @"dy": @400}, &action, &text, &error));
    assert(!parse_action(@{@"action": @"key", @"key": @"f13"}, &action, &text, &error));
    assert(!parse_action(@{@"action": @"key", @"key": @"c", @"modifiers": @[@"hyper"]}, &action, &text, &error));
    assert(!parse_action(@{@"action": @"type", @"text": @""}, &action, &text, &error));
    assert(!parse_action(@{@"action": @"type", @"text": [@"" stringByPaddingToLength:kMaxTypedCharacters + 1 withString:@"a" startingAtIndex:0]}, &action, &text, &error));
    assert(!parse_action(@{@"action": @"launch_missiles", @"x": @1, @"y": @1}, &action, &text, &error));
    assert(!parse_action((NSDictionary *)@[], &action, &text, &error));
}

static DoubleLeftOption tap;
static HoldWatch watch;
static CFMachPortRef listener;

static CGEventRef observe(CGEventTapProxy proxy, CGEventType type, CGEventRef event, void *info) {
    (void)proxy;
    (void)info;
    if (type == kCGEventTapDisabledByTimeout || type == kCGEventTapDisabledByUserInput) {
        CGEventTapEnable(listener, true);
        return event;
    }
    uint16_t key_code = (uint16_t)CGEventGetIntegerValueField(event, kCGKeyboardEventKeycode);
    CGEventFlags flags = CGEventGetFlags(event);
    double time = (double)CGEventGetTimestamp(event) / (double)NSEC_PER_SEC;
    if (handle_tap(&tap, event_input(type, key_code, flags), time)) {
        fputs("toggle\n", stdout);
        fflush(stdout);
    }
    size_t armed = handle_hold(&watch, type, key_code, flags);
    if (!armed) return event;
    uint64_t generation = watch.generation;
    HoldBinding binding = watch.set.items[armed - 1];
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(binding.seconds * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
        if (!hold_survived(&watch, armed, generation)) return;
        watch.armed = 0;
        printf("hold %s\n", binding.id);
        fflush(stdout);
    });
    return event;
}

int main(int argc, const char *argv[]) {
    @autoreleasepool {
        if (argc == 2 && strcmp(argv[1], "--self-test") == 0) {
            self_test();
            return 0;
        }
        if (argc == 2 && strcmp(argv[1], "--screens") == 0) return print_screens();
        if (argc == 2 && strcmp(argv[1], "--selection") == 0) return print_selection();
        if (argc == 2 && strcmp(argv[1], "--input") == 0) return run_input();

        NSDictionary *options = @{(__bridge NSString *)kAXTrustedCheckOptionPrompt: @YES};
        if (!AXIsProcessTrustedWithOptions((__bridge CFDictionaryRef)options)) {
            fputs("Emma: Accessibility access is required for double-left-Option Quick Ask. Grant it in System Settings, then relaunch Emma.\n", stderr);
        }

        __block NSMutableData *pending = [NSMutableData data];
        NSFileHandle *input = [NSFileHandle fileHandleWithStandardInput];
        input.readabilityHandler = ^(NSFileHandle *handle) {
            @autoreleasepool {
                NSData *chunk = [handle availableData];
                if (!chunk.length) { handle.readabilityHandler = nil; exit(0); }
                [pending appendData:chunk];
                if (pending.length > 8192) { pending = [NSMutableData data]; return; }
                const char *bytes = pending.bytes;
                NSUInteger start = 0;
                for (NSUInteger index = 0; index < pending.length; index += 1) {
                    if (bytes[index] != '\n') continue;
                    NSData *line = [pending subdataWithRange:NSMakeRange(start, index - start)];
                    start = index + 1;
                    NSDictionary *object = line.length ? [NSJSONSerialization JSONObjectWithData:line options:0 error:NULL] : nil;
                    HoldSet parsed = object ? parse_holds(object) : (HoldSet){0};
                    dispatch_async(dispatch_get_main_queue(), ^{
                        watch.set = parsed;
                        watch.armed = 0;
                        watch.generation += 1;
                    });
                }
                pending = [[pending subdataWithRange:NSMakeRange(start, pending.length - start)] mutableCopy];
            }
        };
        listener = CGEventTapCreate(kCGSessionEventTap, kCGHeadInsertEventTap, kCGEventTapOptionListenOnly,
            CGEventMaskBit(kCGEventFlagsChanged) | CGEventMaskBit(kCGEventKeyDown), observe, NULL);
        if (!listener) {
            fputs("Emma: unable to start the Quick Ask hotkey listener.\n", stderr);
            return 1;
        }
        CFRunLoopSourceRef source = CFMachPortCreateRunLoopSource(NULL, listener, 0);
        CFRunLoopAddSource(CFRunLoopGetCurrent(), source, kCFRunLoopCommonModes);
        CFRelease(source);
        CGEventTapEnable(listener, true);
        CFRunLoopRun();
    }
    return 0;
}
