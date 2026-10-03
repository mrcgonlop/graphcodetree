import os

class Greeter:
    def hi(self):
        return os.getcwd()

def main():
    g = Greeter()
    print(g.hi())
