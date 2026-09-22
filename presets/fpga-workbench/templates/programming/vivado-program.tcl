# Vivado programming-only template.
# Required variables before source:
#   BITSTREAM_FILE
# Optional:
#   DEVICE_FILTER - Vivado get_hw_devices filter; required when more than one device is found
#
# This script never synthesizes, implements, or creates a bitstream.

if {![info exists BITSTREAM_FILE] || $BITSTREAM_FILE eq ""} {
    error "BITSTREAM_FILE is required; select an existing reviewed bitstream"
}
if {![file isfile $BITSTREAM_FILE]} {
    error "bitstream does not exist: $BITSTREAM_FILE"
}

open_hw_manager
connect_hw_server
open_hw_target

if {[info exists DEVICE_FILTER] && $DEVICE_FILTER ne ""} {
    set devices [get_hw_devices -filter $DEVICE_FILTER]
} else {
    set devices [get_hw_devices]
}
if {[llength $devices] == 0} {
    error "no hardware device matched; check cable, target, and DEVICE_FILTER"
}
if {[llength $devices] > 1} {
    error "multiple hardware devices matched; set DEVICE_FILTER explicitly"
}

set device [lindex $devices 0]
current_hw_device $device
refresh_hw_device $device
set_property PROGRAM.FILE $BITSTREAM_FILE $device
program_hw_devices $device

puts "PROGRAMMING PASSED: $device <- $BITSTREAM_FILE"
