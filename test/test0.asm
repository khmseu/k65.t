.macro aa,b
.byte \b
n=n+1
.endmacro

n=0

@x1
 aa 42
a42=n

@x2 aa 37
a37=n
nop
end
