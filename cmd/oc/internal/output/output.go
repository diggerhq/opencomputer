package output

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"text/tabwriter"
)

// Printer handles output formatting (table or JSON).
type Printer struct {
	JSON bool
	W    io.Writer
}

// New creates a printer that writes to stdout.
func New(jsonOutput bool) *Printer {
	return &Printer{JSON: jsonOutput, W: os.Stdout}
}

// PrintJSON outputs v as indented JSON.
func (p *Printer) PrintJSON(v interface{}) error {
	enc := json.NewEncoder(p.W)
	enc.SetIndent("", "  ")
	return enc.Encode(v)
}

// Table prints a table with headers and rows.
func (p *Printer) Table(headers []string, rows [][]string) {
	w := tabwriter.NewWriter(p.W, 0, 4, 2, ' ', 0)
	for i, h := range headers {
		if i > 0 {
			fmt.Fprint(w, "\t")
		}
		fmt.Fprint(w, h)
	}
	fmt.Fprintln(w)
	for _, row := range rows {
		for i, col := range row {
			if i > 0 {
				fmt.Fprint(w, "\t")
			}
			fmt.Fprint(w, col)
		}
		fmt.Fprintln(w)
	}
	w.Flush()
}

// Print outputs v as JSON if --json is set, otherwise calls the fallback.
func (p *Printer) Print(v interface{}, tableFn func()) {
	if p.JSON {
		p.PrintJSON(v)
		return
	}
	tableFn()
}
