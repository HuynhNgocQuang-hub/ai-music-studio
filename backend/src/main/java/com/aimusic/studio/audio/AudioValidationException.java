package com.aimusic.studio.audio;

import org.springframework.http.HttpStatus;

public class AudioValidationException extends RuntimeException {

    private final HttpStatus status;

    public AudioValidationException(String detail, HttpStatus status) {
        super(detail);
        this.status = status;
    }

    public HttpStatus getStatus() {
        return status;
    }
}
