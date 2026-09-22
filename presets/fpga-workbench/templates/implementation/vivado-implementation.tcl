# Vivado implementation-only template.
# Required variables before source:
#   PROJECT_NAME, SYNTH_DCP, OUTPUT_DIR
# Optional:
#   BITSTREAM_OUT (default: OUTPUT_DIR/PROJECT_NAME.bit)
# This script opens an existing synthesized checkpoint; it never calls synth_design
# and it never opens hardware/programs a device.

foreach required {PROJECT_NAME SYNTH_DCP OUTPUT_DIR} {
    if {![info exists $required] || [set $required] eq ""} {
        error "$required is required; set it from confirmed project facts before sourcing this script"
    }
}
if {![file isfile $SYNTH_DCP]} {
    error "synthesized checkpoint does not exist: $SYNTH_DCP"
}
if {![file isdirectory $OUTPUT_DIR]} {
    file mkdir $OUTPUT_DIR
}
if {![info exists BITSTREAM_OUT] || $BITSTREAM_OUT eq ""} {
    set BITSTREAM_OUT [file join $OUTPUT_DIR "${PROJECT_NAME}.bit"]
}

open_checkpoint $SYNTH_DCP
opt_design
place_design
phys_opt_design
route_design

set timing_paths [get_timing_paths -delay_type max -max_paths 1 -nworst 1]
if {[llength $timing_paths] == 0} {
    error "implementation produced no setup timing path; confirm clocks and constraints"
}

write_checkpoint -force [file join $OUTPUT_DIR "${PROJECT_NAME}_routed.dcp"]
report_utilization -file [file join $OUTPUT_DIR "${PROJECT_NAME}_impl_utilization.rpt"]
report_timing_summary -file [file join $OUTPUT_DIR "${PROJECT_NAME}_impl_timing.rpt"]
write_bitstream -force $BITSTREAM_OUT

if {![file isfile $BITSTREAM_OUT]} {
    error "bitstream was not created: $BITSTREAM_OUT"
}
puts "IMPLEMENTATION PASSED: $BITSTREAM_OUT"
