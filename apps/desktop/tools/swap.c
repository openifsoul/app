#include <stdio.h>

int main(int argc, char **argv) {
    if (argc != 3)
        return 2;
    if (renamex_np(argv[1], argv[2], RENAME_SWAP) == 0)
        return 0;
    perror("Could not exchange IfSoul app bundles");
    return 1;
}
