import re

def chunk_text(text: str, max_chunk_size: int = 1500) -> list:
    """Split text into semantic chunks on heading/paragraph boundaries."""
    if not text or len(text) <= max_chunk_size:
        return [text] if text else []
    
    sections = re.split(r'\n(?=#{1,3} )', text)
    chunks = []
    
    for section in sections:
        section = section.strip()
        if not section:
            continue
        if len(section) <= max_chunk_size:
            chunks.append(section)
        else:
            paras = section.split('\n\n')
            current = ''
            for para in paras:
                if len(current) + len(para) + 2 <= max_chunk_size:
                    current = (current + '\n\n' + para).strip()
                else:
                    if current:
                        chunks.append(current)
                    if len(para) > max_chunk_size:
                        for i in range(0, len(para), max_chunk_size):
                            chunks.append(para[i:i+max_chunk_size])
                        current = ''
                    else:
                        current = para
            if current:
                chunks.append(current)
    
    return [c for c in chunks if len(c.strip()) > 50]