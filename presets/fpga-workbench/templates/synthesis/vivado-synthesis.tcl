# Vivado synthesis-only template.
# Required variables before source:
#   PROJECT_NAME, PART, TOP, RTL_FILES, CONSTRAINT_FILES, OUTPUT_DIR
# This script deliberately stops after synthesis and never starts implementation.

foreach required {PROJECT_NAME PART TOP RTL_FILES CONSTRAINT_FILES OUTPUT_DIR} {
    if {![info exists $required] || [set $required] eq ""} {
        error "$required is required; set it from confirmed project facts before sourcing this script"
    }
}
if {[llength $RTL_FILES] == 0} {
    error "RTL_FILES must contain at least one source file"
}
if {![file isdirectory $OUTPUT_DIR]} {
    file mkdir $OUTPUT_DIR
}

foreach source_file $RTL_FILES {
    if {![file isfile $source_file]} {
        error "RTL source does not exist: $source_file"
    }
    set extension [string tolower [file extension $source_file]]
    if {$extension eq ".vhd" || $extension eq ".vhdl"} {
        read_vhdl -vhdl2008 $source_file
    } elseif {$extension eq ".sv" || $extension eq ".svh"} {
        read_verilog -sv $source_file
    } else {
        read_verilog $source_file
    }
}
foreach constraint_file $CONSTRAINT_FILES {
    if {![file isfile $constraint_file]} {
        error "constraint file does not exist: $constraint_file"
    }
    read_xdc $constraint_file
}

synth_design -top $TOP -part $PART
write_checkpoint -force [file join $OUTPUT_DIR "${PROJECT_NAME}_synth.dcp"]
report_utilization -file [file join $OUTPUT_DIR "${PROJECT_NAME}_synth_utilization.rpt"]
report_timing_summary -file [file join $OUTPUT_DIR "${PROJECT_NAME}_synth_timing.rpt"]

if {[get_property DESIGN_MODE [current_design]] ne "RTL" && [llength [get_cells -hierarchical]] == 0} {
    error "synthesis produced no design cells"
}
puts "SYNTHESIS PASSED: [file join $OUTPUT_DIR ${PROJECT_NAME}_synth.dcp]"
