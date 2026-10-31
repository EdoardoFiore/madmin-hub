"""
Address lists (CIDR allowlists of API keys and of the token-less registration).
"""
import ipaddress
from typing import List


def parse_cidrs(raw: str) -> List[ipaddress._BaseNetwork]:
    """'10.0.0.0/8, 192.168.1.5' -> networks. Raises ValueError."""
    nets = []
    for part in (raw or "").replace("\n", ",").split(","):
        part = part.strip()
        if not part:
            continue
        try:
            nets.append(ipaddress.ip_network(part, strict=False))
        except ValueError:
            raise ValueError(f"Rete non valida: {part}")
    return nets


def ip_allowed(ip: str, cidrs: str) -> bool:
    """True when the list is empty or contains ip."""
    nets = parse_cidrs(cidrs)
    if not nets:
        return True
    try:
        addr = ipaddress.ip_address(ip)
    except ValueError:
        return False
    if getattr(addr, "ipv4_mapped", None):
        addr = addr.ipv4_mapped
    return any(addr in n for n in nets)
