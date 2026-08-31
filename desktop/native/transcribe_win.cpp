#define WIN32_LEAN_AND_MEAN
#ifndef _WIN32_WINNT
#define _WIN32_WINNT 0x0601
#endif
#include <windows.h>
#include <sapi.h>
#include "windows_path.hpp"

#include <chrono>
#include <iostream>
#include <string>

std::wstring wide_from_utf8(const char* value) {
    if (!value) return {};
    const int length = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value, -1, nullptr, 0);
    if (length <= 0) return {};
    std::wstring result(static_cast<size_t>(length), L'\0');
    if (MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value, -1, result.data(), length) <= 0) return {};
    result.resize(static_cast<size_t>(length - 1));
    return result;
}

std::string utf8_from_wide(const wchar_t* value) {
    if (!value) return {};
    const int length = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value, -1, nullptr, 0, nullptr, nullptr);
    if (length <= 0) return {};
    std::string result(static_cast<size_t>(length), '\0');
    if (WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value, -1, result.data(), length, nullptr, nullptr) <= 0) return {};
    result.resize(static_cast<size_t>(length - 1));
    return result;
}

int fail(const std::string& message) {
    std::cerr << message << std::endl;
    return 1;
}

template <typename T>
void release(T* value) {
    if (value) value->Release();
}

std::string hresult_message(const char* operation, HRESULT result) {
    return std::string(operation) + " failed (0x" + std::to_string(static_cast<unsigned long>(result)) + ").";
}

void release_event(SPEVENT& event) {
    if (!event.lParam) return;
    if (event.elParamType == SPET_LPARAM_IS_OBJECT || event.elParamType == SPET_LPARAM_IS_TOKEN) {
        reinterpret_cast<IUnknown*>(event.lParam)->Release();
    } else if (event.elParamType == SPET_LPARAM_IS_STRING) {
        CoTaskMemFree(reinterpret_cast<void*>(event.lParam));
    }
    event.lParam = 0;
}

HRESULT create_recognizer(ISpRecognizer** recognizer, ISpRecoContext** context, ISpRecoGrammar** grammar) {
    *recognizer = nullptr;
    *context = nullptr;
    *grammar = nullptr;
    HRESULT result = CoCreateInstance(CLSID_SpInprocRecognizer, nullptr, CLSCTX_INPROC_SERVER, IID_ISpRecognizer, reinterpret_cast<void**>(recognizer));
    if (FAILED(result)) return result;
    result = (*recognizer)->CreateRecoContext(context);
    if (FAILED(result)) return result;
    result = (*context)->CreateGrammar(0, grammar);
    if (FAILED(result)) return result;
    result = (*context)->SetInterest(SPFEI(SPEI_RECOGNITION) | SPFEI(SPEI_END_SR_STREAM), SPFEI(SPEI_RECOGNITION) | SPFEI(SPEI_END_SR_STREAM));
    if (FAILED(result)) return result;
    result = (*context)->SetNotifyWin32Event();
    if (FAILED(result)) return result;
    result = (*grammar)->LoadDictation(nullptr, SPLO_STATIC);
    if (FAILED(result)) return result;
    return S_OK;
}

int check_engine() {
    ISpRecognizer* recognizer = nullptr;
    ISpRecoContext* context = nullptr;
    ISpRecoGrammar* grammar = nullptr;
    const HRESULT result = create_recognizer(&recognizer, &context, &grammar);
    release(grammar);
    release(context);
    release(recognizer);
    if (FAILED(result)) return fail(hresult_message("Windows speech recognition", result));
    std::cout << "ready" << std::endl;
    return 0;
}

int transcribe(const std::wstring& file) {
    const auto extended_file = emma_windows_path::extended_length(file);
    if (extended_file.empty() || GetFileAttributesW(extended_file.c_str()) == INVALID_FILE_ATTRIBUTES) return fail("That recording is gone.");
    ISpStream* stream = nullptr;
    HRESULT result = CoCreateInstance(CLSID_SpStream, nullptr, CLSCTX_INPROC_SERVER, IID_ISpStream, reinterpret_cast<void**>(&stream));
    if (SUCCEEDED(result)) result = stream->BindToFile(extended_file.c_str(), SPFM_OPEN_READONLY, &SPDFID_WaveFormatEx, nullptr, SPFEI_ALL_EVENTS);
    if (FAILED(result)) return fail(hresult_message("Opening the WAV recording", result));
    ISpRecognizer* recognizer = nullptr;
    ISpRecoContext* context = nullptr;
    ISpRecoGrammar* grammar = nullptr;
    result = create_recognizer(&recognizer, &context, &grammar);
    if (FAILED(result)) {
        release(stream);
        return fail(hresult_message("Windows speech recognition", result));
    }
    result = recognizer->SetInput(stream, TRUE);
    if (FAILED(result)) {
        release(grammar);
        release(context);
        release(recognizer);
        release(stream);
        return fail(hresult_message("Selecting the WAV recording", result));
    }
    result = grammar->SetDictationState(SPRS_ACTIVE);
    if (FAILED(result)) {
        release(grammar);
        release(context);
        release(recognizer);
        release(stream);
        return fail(hresult_message("Activating Windows dictation", result));
    }
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(120);
    std::string transcript;
    bool ended = false;
    while (!ended && std::chrono::steady_clock::now() < deadline) {
        const DWORD remaining = static_cast<DWORD>(std::chrono::duration_cast<std::chrono::milliseconds>(deadline - std::chrono::steady_clock::now()).count());
        if (WaitForSingleObject(context->GetNotifyEventHandle(), remaining > 0 ? remaining : 1) != WAIT_OBJECT_0) break;
        SPEVENT events[16] = {};
        ULONG fetched = 0;
        while (SUCCEEDED(context->GetEvents(16, events, &fetched)) && fetched > 0) {
            for (ULONG index = 0; index < fetched; index += 1) {
                const auto& event = events[index];
                if (event.eEventId == SPEI_END_SR_STREAM) ended = true;
                if (event.eEventId == SPEI_RECOGNITION && event.elParamType == SPET_LPARAM_IS_OBJECT && event.lParam) {
                    auto* resultObject = reinterpret_cast<ISpRecoResult*>(event.lParam);
                    WCHAR* text = nullptr;
                    if (SUCCEEDED(resultObject->GetText(SP_GETWHOLEPHRASE, SP_GETWHOLEPHRASE, TRUE, &text, nullptr))) {
                        const auto value = utf8_from_wide(text);
                        if (!value.empty()) {
                            if (!transcript.empty()) transcript.push_back(' ');
                            transcript += value;
                        }
                    }
                    CoTaskMemFree(text);
                }
                release_event(events[index]);
            }
        }
    }
    grammar->SetDictationState(SPRS_INACTIVE);
    release(grammar);
    release(context);
    release(recognizer);
    release(stream);
    if (transcript.empty()) return fail(ended ? "The Windows speech recognizer heard nothing." : "The Windows speech recognizer did not answer in time.");
    std::cout << transcript << std::endl;
    return 0;
}

int self_test() {
    const auto wide = wide_from_utf8("Emma speech");
    if (wide != L"Emma speech" || utf8_from_wide(wide.c_str()) != "Emma speech"
        || emma_windows_path::extended_length(L"C:/Users/Emma/recording.wav") != L"\\\\?\\C:\\Users\\Emma\\recording.wav"
        || emma_windows_path::extended_length(L"\\\\server\\share\\recording.wav") != L"\\\\?\\UNC\\server\\share\\recording.wav"
        || !emma_windows_path::extended_length(L"relative.wav").empty()
        || emma_windows_path::without_extended_length(L"\\\\?\\UNC\\server\\share\\recording.wav") != L"\\\\server\\share\\recording.wav") return 1;
    return 0;
}

int wmain(int argc, wchar_t** argv) {
    if (argc == 2 && std::wstring(argv[1]) == L"--self-test") return self_test();
    if (FAILED(CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED))) return fail("Windows speech could not initialize COM.");
    int result = 0;
    if (argc >= 2 && std::wstring(argv[1]) == L"--check") {
        result = check_engine();
    } else if (argc >= 2) {
        result = transcribe(argv[1]);
    } else {
        result = fail("usage: emma-transcribe <wav>|--check [locale]");
    }
    CoUninitialize();
    return result;
}
