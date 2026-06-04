package main

import (
	"testing"

	"golang.org/x/sys/unix"
)

func TestReadableForAccept(t *testing.T) {
	tests := []struct {
		name    string
		revents int16
		want    bool
	}{
		{name: "pollin", revents: unix.POLLIN, want: true},
		{name: "pollhup", revents: unix.POLLHUP, want: false},
		{name: "pollin pollhup", revents: unix.POLLIN | unix.POLLHUP, want: false},
		{name: "pollerr", revents: unix.POLLERR, want: false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := readableForAccept(tt.revents); got != tt.want {
				t.Fatalf("readableForAccept(%v) = %v, want %v", tt.revents, got, tt.want)
			}
		})
	}
}
