# ModelSim / Questa compile-only template.
# Required caller variables:
#   RTL_FILES  - Tcl list of RTL source paths
#   TB_FILES   - Tcl list of testbench source paths
# Optional caller variables:
#   WORK_LIB   - compiled library directory (default: work)
#
# This script deliberately does not call vsim or run.

onerror { error "ModelSim compile failed: $errorInfo" }

if {![info exists RTL_FILES] || [llength $RTL_FILES] == 0} {
    error "RTL_FILES is required and must contain at least one source file"
}
if {![info exists TB_FILES] || [llength $TB_FILES] == 0} {
    error "TB_FILES is required and must contain at least one testbench file"
}
if {![info exists WORK_LIB] || $WORK_LIB eq ""} {
    set WORK_LIB "work"
}

if {![file isdirectory $WORK_LIB]} {
    vlib $WORK_LIB
}
vmap work $WORK_LIB

foreach source_file [concat $RTL_FILES $TB_FILES] {
    if {![file isfile $source_file]} {
        error "source file does not exist: $source_file"
    }
    vlog -sv -work work $source_file
}

puts "COMPILE PASSED: [llength $RTL_FILES] RTL file(s), [llength $TB_FILES] testbench file(s)"
