# Vivado XDC template.
# Replace every <...> placeholder from confirmed board/device facts before use.
# Keep interface pins grouped and keep clocks in a separate section.

# -----------------------------------------------------------------------------
# 1. I/O constraints
# -----------------------------------------------------------------------------
# set_property PACKAGE_PIN <PIN> [get_ports <PORT>]
# set_property IOSTANDARD <STANDARD> [get_ports <PORT>]

# -----------------------------------------------------------------------------
# 2. Clock constraints
# -----------------------------------------------------------------------------
# The period is nanoseconds. Confirm it against the board clock and project spec.
create_clock -name <CLOCK_NAME> -period <PERIOD_NS> [get_ports <CLOCK_PORT>]

# For unrelated clock domains, uncomment and replace both groups explicitly.
# set_clock_groups -asynchronous \
#     -group [get_clocks <CLOCK_A>] \
#     -group [get_clocks <CLOCK_B>]

# -----------------------------------------------------------------------------
# 3. Configuration properties
# -----------------------------------------------------------------------------
# set_property CFGBVS <VALUE> [current_design]
# set_property CONFIG_VOLTAGE <VALUE> [current_design]

# -----------------------------------------------------------------------------
# 4. Debug constraints
# -----------------------------------------------------------------------------
# Add ILA/VIO constraints only after confirming signal names in the elaborated design.
