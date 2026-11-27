/* Standalone fixed-table wasm32 witness, not Atto compiler-generated code.
 * Graph 0: Alpha(final), Zed; events AlphaEvent, Zulu.
 * Graph 1: Idle, Running; events Start, Stop.
 * -2 = invalid index, -1 = no edge, >=0 = graph-local successor.
 */
int flat_machine_successor(int graph, int node, int slot) {
    if ((unsigned)graph >= 2u || (unsigned)node >= 2u || (unsigned)slot >= 2u)
        return -2;
    if (graph == 0) {
        if (node == 0) return -1;
        return slot;
    }
    if (node != slot) return -1;
    return 1 - node;
}
