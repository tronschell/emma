#import <AppKit/AppKit.h>
#import <ApplicationServices/ApplicationServices.h>
#include <assert.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
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

static TapEvent event_input(NSEvent *event) {
    if (event.type == NSEventTypeKeyDown) return TapCancel;
    if (event.type != NSEventTypeFlagsChanged || event.keyCode != kLeftOptionKeyCode) return TapCancel;

    NSEventModifierFlags flags = event.modifierFlags & NSEventModifierFlagDeviceIndependentFlagsMask;
    if (flags == NSEventModifierFlagOption) return TapDown;
    if (flags == 0) return TapUp;
    return TapCancel;
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

    NSEvent *left_down = [NSEvent keyEventWithType:NSEventTypeFlagsChanged location:NSZeroPoint modifierFlags:NSEventModifierFlagOption timestamp:0 windowNumber:0 context:nil characters:@"" charactersIgnoringModifiers:@"" isARepeat:NO keyCode:kLeftOptionKeyCode];
    NSEvent *left_up = [NSEvent keyEventWithType:NSEventTypeFlagsChanged location:NSZeroPoint modifierFlags:0 timestamp:0 windowNumber:0 context:nil characters:@"" charactersIgnoringModifiers:@"" isARepeat:NO keyCode:kLeftOptionKeyCode];
    NSEvent *right_down = [NSEvent keyEventWithType:NSEventTypeFlagsChanged location:NSZeroPoint modifierFlags:NSEventModifierFlagOption timestamp:0 windowNumber:0 context:nil characters:@"" charactersIgnoringModifiers:@"" isARepeat:NO keyCode:61];
    NSEvent *chord_down = [NSEvent keyEventWithType:NSEventTypeFlagsChanged location:NSZeroPoint modifierFlags:(NSEventModifierFlagOption | NSEventModifierFlagCommand) timestamp:0 windowNumber:0 context:nil characters:@"" charactersIgnoringModifiers:@"" isARepeat:NO keyCode:kLeftOptionKeyCode];
    NSEvent *key_down = [NSEvent keyEventWithType:NSEventTypeKeyDown location:NSZeroPoint modifierFlags:0 timestamp:0 windowNumber:0 context:nil characters:@"a" charactersIgnoringModifiers:@"a" isARepeat:NO keyCode:0];
    assert(event_input(left_down) == TapDown);
    assert(event_input(left_up) == TapUp);
    assert(event_input(right_down) == TapCancel);
    assert(event_input(chord_down) == TapCancel);
    assert(event_input(key_down) == TapCancel);
}

int main(int argc, const char *argv[]) {
    @autoreleasepool {
        if (argc == 2 && strcmp(argv[1], "--self-test") == 0) {
            self_test();
            return 0;
        }

        NSDictionary *options = @{(__bridge NSString *)kAXTrustedCheckOptionPrompt: @YES};
        if (!AXIsProcessTrustedWithOptions((__bridge CFDictionaryRef)options)) {
            fputs("Emma: Accessibility access is required for double-left-Option Quick Ask. Grant it in System Settings, then relaunch Emma.\n", stderr);
        }

        NSApplication *application = [NSApplication sharedApplication];
        [application setActivationPolicy:NSApplicationActivationPolicyProhibited];
        [application finishLaunching];

        __block DoubleLeftOption tap = {0};
        id monitor = [NSEvent addGlobalMonitorForEventsMatchingMask:(NSEventMaskFlagsChanged | NSEventMaskKeyDown) handler:^(NSEvent *event) {
            if (handle_tap(&tap, event_input(event), event.timestamp)) {
                fputs("toggle\n", stdout);
                fflush(stdout);
            }
        }];
        if (!monitor) {
            fputs("Emma: unable to start the Quick Ask hotkey listener.\n", stderr);
            return 1;
        }
        [application run];
    }
    return 0;
}
