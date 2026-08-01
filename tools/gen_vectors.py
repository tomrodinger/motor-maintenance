import sys, struct, zlib, json
sys.path.insert(0, '../research/servomotor_repo/python_programs')
from servomotor import communication as C

def enc(addr, cmd, payload=b'', crc=True):
    if addr <= 255: ap = struct.pack('<B', addr)
    else: ap = struct.pack('<BQ', 254, addr)
    content = ap + struct.pack('<B', cmd) + payload
    ps = 1 + len(content) + (4 if crc else 0)
    if ps > 127:
        ps += 2
        pkt = struct.pack('<BH', C.encode_first_byte(127), ps) + content
    else:
        pkt = bytearray([C.encode_first_byte(ps)]) + content
    if crc: pkt = bytes(pkt) + struct.pack('<I', zlib.crc32(pkt) & 0xffffffff)
    return bytes(pkt)

vecs = []
cases = [
    (255, 27, b''),                                    # broadcast system reset
    (255, 20, b''),                                    # detect devices
    (7,   22, b''),                                    # get product info by alias
    (0x1122334455667788, 22, b''),                     # extended addressing
    (0x1122334455667788, 21, bytes([42])),             # set alias
    (3,   2, struct.pack('<iI', 3276800, 62500)),      # trapezoid move 1 rev / 2 s
    (255, 23, b'M17     ' + bytes([3, 5]) + bytes(2048)),  # firmware page (extended size)
]
for addr, cmd, pl in cases:
    vecs.append({'addr': str(addr), 'cmd': cmd, 'payload': pl.hex(), 'packet': enc(addr, cmd, pl).hex()})

# CRC vectors
crcs = [zlib.crc32(b'') & 0xffffffff, zlib.crc32(b'123456789') & 0xffffffff,
        zlib.crc32(bytes(range(256))) & 0xffffffff]
print(json.dumps({'packets': vecs, 'crc': crcs}))
