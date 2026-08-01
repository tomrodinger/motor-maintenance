import zlib, json, sys
FN='../research/servomotor_repo/firmware/firmware_releases/servomotor_M17_fw0.15.9.0_scc3_hw1.5.firmware'
data=open(FN,'rb').read()
model=data[0:8]; scc=data[8]; d=data[9:]
while len(d) & 3: d += b'\x00'
size=(len(d)>>2)-1
crc=zlib.crc32(d[4:])&0xffffffff
payload=size.to_bytes(4,'little')+d[4:]+crc.to_bytes(4,'little')
pages=(len(payload)+2047)//2048
print(json.dumps({'model':model.decode(),'scc':scc,'words':size,'crc':crc,'payloadLen':len(payload),
 'pages':pages,'sha_first_page':zlib.crc32(payload[:2048]),'sha_all':zlib.crc32(payload)}))
