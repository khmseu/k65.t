ROMSW = 1
REALIO = 4

.if ROMSW == 1
val .equ 42
  LDA #$01
.endif

.if ROMSW == 0
val .equ 37
  LDA #$00
.endif

.if val > 40
 ldx #0
.else
 ldx #1
.endif
