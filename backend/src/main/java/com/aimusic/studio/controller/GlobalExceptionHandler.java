package com.aimusic.studio.controller;

import com.aimusic.studio.audio.AudioValidationException;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;
import org.springframework.web.multipart.MaxUploadSizeExceededException;
import org.springframework.web.server.ResponseStatusException;

import java.util.LinkedHashMap;
import java.util.Map;

@RestControllerAdvice
public class GlobalExceptionHandler {

    @ExceptionHandler(AudioValidationException.class)
    public ResponseEntity<Map<String, Object>> handleAudioValidation(AudioValidationException ex) {
        return error(ex.getStatus(), ex.getMessage());
    }

    @ExceptionHandler(ResponseStatusException.class)
    public ResponseEntity<Map<String, Object>> handleResponseStatus(ResponseStatusException ex) {
        String detail = ex.getReason() != null ? ex.getReason() : ex.getMessage();
        return error(HttpStatus.valueOf(ex.getStatusCode().value()), detail);
    }

    @ExceptionHandler(MaxUploadSizeExceededException.class)
    public ResponseEntity<Map<String, Object>> handleMaxUpload(MaxUploadSizeExceededException ex) {
        return error(HttpStatus.PAYLOAD_TOO_LARGE, "Uploaded file exceeds maximum allowed size (50 MB).");
    }

    @ExceptionHandler(IllegalArgumentException.class)
    public ResponseEntity<Map<String, Object>> handleIllegalArgument(IllegalArgumentException ex) {
        return error(HttpStatus.BAD_REQUEST, ex.getMessage());
    }

    private ResponseEntity<Map<String, Object>> error(HttpStatus status, String detail) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("detail", detail != null ? detail : status.getReasonPhrase());
        body.put("message", detail != null ? detail : status.getReasonPhrase());
        body.put("status", status.value());
        return ResponseEntity.status(status).body(body);
    }
}
