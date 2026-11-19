package main

import (
	"io"
	"strings"
)

func stringsReader(s string) io.Reader { return strings.NewReader(s) }
