#import <AppKit/AppKit.h>
#import <ApplicationServices/ApplicationServices.h>
#include <assert.h>
#include <stdbool.h>
#include <stdio.h>
#include <string.h>

typedef enum { TapDown, TapUp, TapCancel } TapEvent;
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

static void self_test(void) {
    DoubleLeftOption tap = {0};
    assert(!handle_tap(&tap, TapDown, 0));
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

        __block DoubleLeftOption tap = {0};
        id monitor = [NSEvent addGlobalMonitorForEventsMatchingMask:(NSEventMaskFlagsChanged | NSEventMaskKeyDown) handler:^(NSEvent *event) {
            TapEvent input = TapCancel;
            if (event.type != NSEventTypeKeyDown && event.keyCode == 58) {
                NSEventModifierFlags chord = event.modifierFlags & (NSEventModifierFlagControl | NSEventModifierFlagShift | NSEventModifierFlagOption | NSEventModifierFlagCommand);
                input = chord == NSEventModifierFlagOption ? TapDown : chord == 0 ? TapUp : TapCancel;
            }
            if (handle_tap(&tap, input, event.timestamp)) {
                fputs("toggle\n", stdout);
                fflush(stdout);
            }
        }];
        if (!monitor) {
            fputs("Emma: unable to start the Quick Ask hotkey listener.\n", stderr);
            return 1;
        }
        [[NSRunLoop mainRunLoop] run];
    }
    return 0;
}
